package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
	"github.com/pkg/errors"
)

const youjiPDFVersion = "7.1.1"

type youjiPDFPage struct {
	Page int    `json:"page"`
	Text string `json:"text"`
}

type youjiPDFResult struct {
	Parser  string         `json:"parser"`
	Version string         `json:"version"`
	SHA256  string         `json:"sha256,omitempty"`
	Pages   []youjiPDFPage `json:"pages"`
	Error   string         `json:"error,omitempty"`
}

type youjiPDFHandler struct {
	python  string
	worker  string
	slot    chan struct{}
	timeout time.Duration
}

func registerYoujiPDFRoutes(mux *runtime.ServeMux) error {
	h := &youjiPDFHandler{python: os.Getenv("YOUJI_PDF_PYTHON"), worker: os.Getenv("YOUJI_PDF_WORKER"), slot: make(chan struct{}, 1), timeout: 17 * time.Second}
	if err := mux.HandlePath(http.MethodGet, "/api/youji/pdf/processor", h.processor); err != nil {
		return err
	}
	return mux.HandlePath(http.MethodPost, "/api/youji/pdf/parse", h.parse)
}

func (h *youjiPDFHandler) available() bool {
	for i, path := range []string{h.python, h.worker} {
		if !filepath.IsAbs(path) {
			return false
		}
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() || (i == 0 && info.Mode()&0111 == 0) {
			return false
		}
	}
	return true
}

func youjiPDFJSON(w http.ResponseWriter, status int, value any) {
	setAPIResponseNoStoreHeaders(w.Header())
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func youjiPDFError(w http.ResponseWriter, status int, code string) {
	youjiPDFJSON(w, status, map[string]string{"error": code})
}

func (h *youjiPDFHandler) processor(w http.ResponseWriter, _ *http.Request, _ map[string]string) {
	available := h.available()
	status := http.StatusOK
	if !available {
		status = http.StatusServiceUnavailable
	}
	youjiPDFJSON(w, status, map[string]any{"available": available, "parser": "pypdf", "version": youjiPDFVersion})
}

// youjiPDFOutput cancels execution before accepting output above the bound.
type youjiPDFOutput struct {
	buffer bytes.Buffer
	cancel context.CancelFunc
}

func (b *youjiPDFOutput) Write(p []byte) (int, error) {
	if len(p) > (2<<20)-b.buffer.Len() {
		b.cancel()
		return 0, errors.New("PDF output limit")
	}
	return b.buffer.Write(p)
}

func (h *youjiPDFHandler) parse(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	if !h.available() {
		youjiPDFError(w, 503, "unavailable")
		return
	}
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/pdf" {
		youjiPDFError(w, 422, "invalid_pdf")
		return
	}
	select {
	case h.slot <- struct{}{}:
		defer func() { <-h.slot }()
	default:
		youjiPDFError(w, 429, "busy")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), h.timeout)
	defer cancel()
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(h.timeout))
	defer func() { _ = http.NewResponseController(w).SetReadDeadline(time.Time{}) }()
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<20))
	if err != nil {
		var sizeError *http.MaxBytesError
		if errors.As(err, &sizeError) {
			youjiPDFError(w, 413, "too_large")
		} else {
			youjiPDFError(w, 422, "invalid_pdf")
		}
		return
	}
	if !bytes.HasPrefix(data, []byte("%PDF-")) {
		youjiPDFError(w, 422, "invalid_pdf")
		return
	}
	cmd := exec.CommandContext(ctx, h.python, "-I", h.worker)
	cmd.Env = []string{"LANG=C.UTF-8"}
	cmd.Stdin = bytes.NewReader(data)
	output := &youjiPDFOutput{cancel: cancel}
	cmd.Stdout = output
	cmd.Stderr = io.Discard
	cmd.WaitDelay = time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			youjiPDFError(w, 504, "cancelled")
		} else {
			youjiPDFError(w, 422, "parse_failed")
		}
		return
	}
	var result youjiPDFResult
	if !utf8.Valid(output.buffer.Bytes()) || json.Unmarshal(output.buffer.Bytes(), &result) != nil {
		youjiPDFError(w, 422, "parse_failed")
		return
	}
	if result.Error != "" {
		switch result.Error {
		case "encrypted_pdf", "invalid_pdf", "page_limit", "text_limit", "no_text", "parse_failed":
			youjiPDFError(w, 422, result.Error)
		case "parser_unavailable":
			youjiPDFError(w, 503, "unavailable")
		default:
			youjiPDFError(w, 422, "parse_failed")
		}
		return
	}
	size, nonempty := 0, false
	if result.Parser != "pypdf" || result.Version != youjiPDFVersion || len(result.Pages) < 1 || len(result.Pages) > 64 {
		youjiPDFError(w, 422, "parse_failed")
		return
	}
	for i, page := range result.Pages {
		size += len(page.Text)
		nonempty = nonempty || strings.TrimSpace(page.Text) != ""
		if page.Page != i+1 || size > 256<<10 {
			youjiPDFError(w, 422, "parse_failed")
			return
		}
	}
	if !nonempty {
		youjiPDFError(w, 422, "no_text")
		return
	}
	digest := sha256.Sum256(data)
	result.SHA256 = hex.EncodeToString(digest[:])
	youjiPDFJSON(w, 200, result)
}
