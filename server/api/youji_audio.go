package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"math"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
	"github.com/pkg/errors"
)

type youjiAudioSegment struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
}

type youjiAudioResult struct {
	Available bool                `json:"available,omitempty"`
	Engine    string              `json:"engine"`
	Model     string              `json:"model"`
	Revision  string              `json:"revision"`
	Language  string              `json:"language"`
	SHA256    string              `json:"sha256,omitempty"`
	Duration  float64             `json:"duration,omitempty"`
	Segments  []youjiAudioSegment `json:"segments,omitempty"`
	Text      string              `json:"text,omitempty"`
	Error     string              `json:"error,omitempty"`
}

type youjiAudioHandler struct {
	python, worker, model string
	slot                  chan struct{}
	timeout, checkTimeout time.Duration
}

// registerYoujiAudioRoutes uses the existing protected gateway middleware.
func registerYoujiAudioRoutes(mux *runtime.ServeMux) error {
	h := &youjiAudioHandler{python: os.Getenv("YOUJI_AUDIO_PYTHON"), worker: os.Getenv("YOUJI_AUDIO_WORKER"), model: os.Getenv("YOUJI_AUDIO_MODEL"), slot: make(chan struct{}, 1), timeout: 180 * time.Second, checkTimeout: 20 * time.Second}
	if err := mux.HandlePath(http.MethodGet, "/api/youji/audio/processor", h.processor); err != nil {
		return err
	}
	return mux.HandlePath(http.MethodPost, "/api/youji/audio/transcribe", h.transcribe)
}

func (h *youjiAudioHandler) configured() bool {
	if !(&youjiPDFHandler{python: h.python, worker: h.worker}).available() || !filepath.IsAbs(h.model) {
		return false
	}
	directory, err := os.Stat(h.model)
	if err != nil || !directory.IsDir() {
		return false
	}
	manifest, err := os.Stat(filepath.Join(h.model, "manifest.json"))
	return err == nil && manifest.Mode().IsRegular() && manifest.Size() > 0 && manifest.Size() <= 65536
}

func youjiAudioError(w http.ResponseWriter, code string) {
	status := http.StatusUnprocessableEntity
	switch code {
	case "unavailable":
		status = http.StatusServiceUnavailable
	case "busy":
		status = http.StatusTooManyRequests
	case "timeout":
		status = http.StatusGatewayTimeout
	case "too_large":
		status = http.StatusRequestEntityTooLarge
	case "invalid_audio", "no_speech", "too_long":
	default:
		code = "unavailable"
		status = http.StatusServiceUnavailable
	}
	youjiPDFError(w, status, code)
}

func validYoujiAudioMetadata(result youjiAudioResult) bool {
	if result.Engine != "faster-whisper" || result.Language != "zh" {
		return false
	}
	switch result.Model {
	case "Systran/faster-whisper-tiny", "Systran/faster-whisper-base", "Systran/faster-whisper-small":
	default:
		return false
	}
	valid, _ := regexp.MatchString(`^[a-f0-9]{40}$`, result.Revision)
	return valid
}

func (h *youjiAudioHandler) run(ctx context.Context, data []byte, check bool) (youjiAudioResult, string) {
	args := []string{"-I", h.worker, "--model-dir", h.model}
	if check {
		args = append(args, "--check")
	}
	outputCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	// The output limiter cancels the same context that owns the child process.
	cmd := exec.CommandContext(outputCtx, h.python, args...)
	cmd.Env = []string{"LANG=C.UTF-8"}
	cmd.Stdin = bytes.NewReader(data)
	output := &youjiPDFOutput{cancel: cancel}
	cmd.Stdout = output
	cmd.Stderr = io.Discard
	cmd.WaitDelay = time.Second
	if err := cmd.Run(); err != nil {
		if outputCtx.Err() != nil {
			return youjiAudioResult{}, "timeout"
		}
		return youjiAudioResult{}, "unavailable"
	}
	var result youjiAudioResult
	if !utf8.Valid(output.buffer.Bytes()) || json.Unmarshal(output.buffer.Bytes(), &result) != nil {
		return result, "unavailable"
	}
	if result.Error != "" {
		switch result.Error {
		case "invalid_audio", "no_speech", "too_long", "unavailable":
			return result, result.Error
		default:
			return youjiAudioResult{}, "unavailable"
		}
	}
	if !validYoujiAudioMetadata(result) {
		return youjiAudioResult{}, "unavailable"
	}
	return result, ""
}

func (h *youjiAudioHandler) processor(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	if !h.configured() {
		youjiAudioError(w, "unavailable")
		return
	}
	select {
	case h.slot <- struct{}{}:
		defer func() { <-h.slot }()
	default:
		youjiAudioError(w, "busy")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), h.checkTimeout)
	defer cancel()
	result, code := h.run(ctx, nil, true)
	if code != "" {
		youjiAudioError(w, code)
		return
	}
	if !result.Available {
		youjiAudioError(w, "unavailable")
		return
	}
	// --check verifies every manifest file and the bundled VAD, without loading weights.
	youjiPDFJSON(w, 200, map[string]any{"available": true, "engine": result.Engine, "model": result.Model, "revision": result.Revision, "language": "zh", "maxDuration": 120, "maxBytes": 16 << 20})
}

func (h *youjiAudioHandler) transcribe(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	if !h.configured() {
		youjiAudioError(w, "unavailable")
		return
	}
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/octet-stream" {
		youjiAudioError(w, "invalid_audio")
		return
	}
	select {
	case h.slot <- struct{}{}:
		defer func() { <-h.slot }()
	default:
		youjiAudioError(w, "busy")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), h.timeout)
	defer cancel()
	deadline, _ := ctx.Deadline()
	_ = http.NewResponseController(w).SetReadDeadline(deadline)
	defer func() { _ = http.NewResponseController(w).SetReadDeadline(time.Time{}) }()
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<20))
	if err != nil {
		var bound *http.MaxBytesError
		if errors.As(err, &bound) {
			youjiAudioError(w, "too_large")
		} else {
			youjiAudioError(w, "invalid_audio")
		}
		return
	}
	if len(data) == 0 {
		youjiAudioError(w, "invalid_audio")
		return
	}
	result, code := h.run(ctx, data, false)
	if code != "" {
		youjiAudioError(w, code)
		return
	}
	digest := sha256.Sum256(data)
	if result.SHA256 != hex.EncodeToString(digest[:]) || math.IsNaN(result.Duration) || math.IsInf(result.Duration, 0) || result.Duration <= 0 || result.Duration > 120 || len(result.Segments) == 0 || len(result.Segments) > 1000 || len(result.Text) > 65536 {
		youjiAudioError(w, "invalid_audio")
		return
	}
	var text strings.Builder
	previous := 0.0
	for _, segment := range result.Segments {
		if math.IsNaN(segment.Start) || math.IsNaN(segment.End) || math.IsInf(segment.Start, 0) || math.IsInf(segment.End, 0) || segment.Start < previous || segment.End < segment.Start || segment.End > result.Duration+1 || strings.TrimSpace(segment.Text) == "" || text.Len()+len(segment.Text) > 65536 {
			youjiAudioError(w, "invalid_audio")
			return
		}
		previous = segment.Start
		text.WriteString(segment.Text)
	}
	if strings.TrimSpace(text.String()) != result.Text || result.Text == "" {
		youjiAudioError(w, "invalid_audio")
		return
	}
	if ctx.Err() != nil {
		youjiAudioError(w, "timeout")
		return
	}
	result.Available = false
	youjiPDFJSON(w, 200, result)
}
