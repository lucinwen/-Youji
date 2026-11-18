package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
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

	"github.com/usememos/memos/store"
)

const youjiRetrievalModel = "intfloat/multilingual-e5-small"
const youjiRetrievalRevision = "614241f622f53c4eeff9890bdc4f31cfecc418b3"

type youjiRetrievalHit struct {
	ID      string  `json:"id"`
	Score   float64 `json:"score"`
	Excerpt string  `json:"excerpt"`
}

type youjiRetrievalOutput struct {
	Hits      []youjiRetrievalHit `json:"hits"`
	Model     string              `json:"model"`
	Revision  string              `json:"revision"`
	Truncated bool                `json:"truncated"`
}

type youjiRetrievalHandler struct {
	python, worker, model string
	slot                  chan struct{}
	timeout               time.Duration
	load                  func(context.Context, string, []string) ([]*store.Memo, error)
}

func (s *APIService) registerYoujiRetrievalRoutes(mux *runtime.ServeMux) error {
	h := &youjiRetrievalHandler{
		python: os.Getenv("YOUJI_RETRIEVAL_PYTHON"), worker: os.Getenv("YOUJI_RETRIEVAL_WORKER"), model: os.Getenv("YOUJI_RETRIEVAL_MODEL"),
		slot: make(chan struct{}, 1), timeout: 60 * time.Second, load: s.youjiRetrievalCandidates,
	}
	if err := mux.HandlePath(http.MethodGet, "/api/youji/retrieval/processor", h.processor); err != nil {
		return err
	}
	return mux.HandlePath(http.MethodPost, "/api/youji/retrieval/search", h.search)
}

func youjiRetrievalFind(owner int32, scope *store.MemoAccessScope, filter string, ids []string) *store.FindMemo {
	normal, limit := store.Normal, 101
	return &store.FindMemo{CreatorID: &owner, Access: scope, RowStatus: &normal, ExcludeComments: true, Filters: []string{filter}, UIDList: ids, Limit: &limit}
}

func (s *APIService) youjiRetrievalCandidates(ctx context.Context, filter string, ids []string) ([]*store.Memo, error) {
	scope, user, err := s.resolveMemoAccessScope(ctx)
	if err != nil || user == nil {
		return nil, errors.New("retrieval unauthorized")
	}
	if filter != "" {
		if err := s.validateMemoFilterForUser(ctx, filter, user); err != nil {
			return nil, errors.New("retrieval filter rejected")
		}
	}
	find := youjiRetrievalFind(user.ID, scope, filter, ids)
	if filter == "" {
		find.Filters = nil
	}
	return s.Store.ListMemos(ctx, find)
}

func (h *youjiRetrievalHandler) available() bool {
	pdf := &youjiPDFHandler{python: h.python, worker: h.worker}
	if !pdf.available() || !filepath.IsAbs(h.model) {
		return false
	}
	info, err := os.Stat(h.model)
	if err != nil || !info.IsDir() {
		return false
	}
	for _, name := range []string{"model_qint8_avx512_vnni.onnx", "tokenizer.json", "config.json"} {
		info, err := os.Stat(filepath.Join(h.model, name))
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			return false
		}
	}
	return true
}

func (h *youjiRetrievalHandler) processor(w http.ResponseWriter, _ *http.Request, _ map[string]string) {
	status := http.StatusOK
	if !h.available() {
		status = http.StatusServiceUnavailable
	}
	youjiPDFJSON(w, status, map[string]any{"available": status == http.StatusOK, "model": youjiRetrievalModel, "revision": youjiRetrievalRevision, "persistentIndex": false})
}

func (h *youjiRetrievalHandler) search(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	if !h.available() {
		youjiPDFError(w, 503, "unavailable")
		return
	}
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		youjiPDFError(w, 422, "invalid_request")
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
	var request struct {
		Query  string `json:"query"`
		Filter string `json:"filter"`
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 32<<10))
	if err != nil || !utf8.Valid(raw) || json.Unmarshal(raw, &request) != nil || strings.TrimSpace(request.Query) == "" || utf8.RuneCountInString(strings.TrimSpace(request.Query)) > 200 || len(request.Filter) > 16384 {
		youjiPDFError(w, 422, "invalid_request")
		return
	}
	request.Query = strings.TrimSpace(request.Query)
	memos, err := h.load(ctx, request.Filter, nil)
	if err != nil {
		youjiPDFError(w, 422, "candidates_unavailable")
		return
	}
	truncated := len(memos) > 100
	if truncated {
		memos = memos[:100]
	}
	type document struct {
		ID   string `json:"id"`
		Text string `json:"text"`
	}
	documents := []document{}
	originals := map[string]*store.Memo{}
	total := 0
	for _, memo := range memos {
		if total+len(memo.Content) > 512<<10 {
			truncated = true
			break
		}
		total += len(memo.Content)
		name := "memos/" + memo.UID
		originals[name] = memo
		documents = append(documents, document{ID: name, Text: memo.Content})
	}
	if len(documents) == 0 {
		youjiPDFJSON(w, 200, map[string]any{"hits": []any{}, "model": youjiRetrievalModel, "revision": youjiRetrievalRevision, "truncated": truncated})
		return
	}
	input, err := json.Marshal(struct {
		Query     string     `json:"query"`
		Documents []document `json:"documents"`
	}{request.Query, documents})
	if err != nil {
		youjiPDFError(w, 422, "invalid_request")
		return
	}
	if len(input) > 1<<20 {
		youjiPDFError(w, 413, "too_large")
		return
	}
	cmd := exec.CommandContext(ctx, h.python, "-I", h.worker, "--model-dir", h.model)
	cmd.Env = []string{"LANG=C.UTF-8"}
	cmd.Stdin = bytes.NewReader(input)
	output := &youjiPDFOutput{cancel: cancel}
	cmd.Stdout = output
	cmd.Stderr = io.Discard
	cmd.WaitDelay = time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			youjiPDFError(w, 504, "cancelled")
		} else {
			youjiPDFError(w, 422, "search_failed")
		}
		return
	}
	var result youjiRetrievalOutput
	if !utf8.Valid(output.buffer.Bytes()) || json.Unmarshal(output.buffer.Bytes(), &result) != nil || result.Hits == nil || len(result.Hits) > 5 || result.Model != youjiRetrievalModel || result.Revision != youjiRetrievalRevision {
		youjiPDFError(w, 422, "invalid_processor_output")
		return
	}
	seen := map[string]bool{}
	ids := []string{}
	for _, hit := range result.Hits {
		memo := originals[hit.ID]
		if memo == nil || seen[hit.ID] || math.IsNaN(hit.Score) || math.IsInf(hit.Score, 0) || hit.Score < -1.000001 || hit.Score > 1.000001 || hit.Excerpt == "" || len(hit.Excerpt) > 4096 || !strings.Contains(memo.Content, hit.Excerpt) {
			youjiPDFError(w, 422, "invalid_processor_output")
			return
		}
		seen[hit.ID] = true
		ids = append(ids, memo.UID)
	}
	if len(ids) > 0 {
		fresh, err := h.load(ctx, request.Filter, ids)
		if err != nil {
			youjiPDFError(w, 409, "results_changed")
			return
		}
		current := map[string]*store.Memo{}
		for _, memo := range fresh {
			current["memos/"+memo.UID] = memo
		}
		for _, hit := range result.Hits {
			memo := current[hit.ID]
			if memo == nil || memo.Content != originals[hit.ID].Content || memo.CreatorID != originals[hit.ID].CreatorID {
				youjiPDFError(w, 409, "results_changed")
				return
			}
		}
	}
	if ctx.Err() != nil {
		youjiPDFError(w, 504, "cancelled")
		return
	}
	type hit struct {
		Name    string  `json:"name"`
		Score   float64 `json:"score"`
		Excerpt string  `json:"excerpt"`
	}
	hits := []hit{}
	for _, item := range result.Hits {
		hits = append(hits, hit{Name: item.ID, Score: item.Score, Excerpt: item.Excerpt})
	}
	youjiPDFJSON(w, 200, map[string]any{"hits": hits, "model": result.Model, "revision": result.Revision, "truncated": truncated || result.Truncated})
}
