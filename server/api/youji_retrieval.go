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
	metadata              func(context.Context, string) (int32, []*store.Memo, error)
	// Tests may replace model hashing for their explicitly synthetic worker only.
	verifyModel func(context.Context) bool
}

func (s *APIService) registerYoujiRetrievalRoutes(mux *runtime.ServeMux) error {
	h := &youjiRetrievalHandler{
		python: os.Getenv("YOUJI_RETRIEVAL_PYTHON"), worker: os.Getenv("YOUJI_RETRIEVAL_WORKER"), model: os.Getenv("YOUJI_RETRIEVAL_MODEL"),
		slot: make(chan struct{}, 1), timeout: 60 * time.Second, load: s.youjiRetrievalCandidates, metadata: s.youjiRetrievalMetadata,
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
	if len(ids) == 0 || len(ids) > 100 {
		return nil, errors.New("retrieval candidate bound")
	}
	_, memos, err := s.youjiRetrievalRead(ctx, filter, ids, false)
	return memos, err
}

func (s *APIService) youjiRetrievalMetadata(ctx context.Context, filter string) (int32, []*store.Memo, error) {
	return s.youjiRetrievalRead(ctx, filter, nil, true)
}

func (s *APIService) youjiRetrievalRead(ctx context.Context, filter string, ids []string, metadata bool) (int32, []*store.Memo, error) {
	scope, user, err := s.resolveMemoAccessScope(ctx)
	if err != nil || user == nil {
		return 0, nil, errors.New("retrieval unauthorized")
	}
	if filter != "" {
		if err := s.validateMemoFilterForUser(ctx, filter, user); err != nil {
			return 0, nil, errors.New("retrieval filter rejected")
		}
	}
	find := youjiRetrievalFind(user.ID, scope, filter, ids)
	if metadata {
		limit := 5001
		find.Limit = &limit
		find.ExcludeContent = true
		find.ExcludePayload = true
	}
	if filter == "" {
		find.Filters = nil
	}
	memos, err := s.Store.ListMemos(ctx, find)
	return user.ID, memos, err
}

// The fingerprint covers only the bounded visible metadata window, never content.
func youjiRetrievalSnapshot(owner int32, filter, query string, memos []*store.Memo) string {
	type entry struct {
		ID, Creator      int32
		UID              string
		Created, Updated int64
		Visibility       store.Visibility
		State            store.RowStatus
		Space            *int32
		Pinned           bool
	}
	entries := make([]entry, 0, len(memos))
	for _, memo := range memos {
		entries = append(entries, entry{memo.ID, memo.CreatorID, memo.UID, memo.CreatedTs, memo.UpdatedTs, memo.Visibility, memo.RowStatus, memo.SpaceID, memo.Pinned})
	}
	data, _ := json.Marshal(struct {
		Owner         int32
		Filter, Query string
		Entries       []entry
	}{owner, filter, query, entries})
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
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

func (h *youjiRetrievalHandler) processor(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	h.processorRequest(w, r.Context())
}

func (h *youjiRetrievalHandler) processorRequest(w http.ResponseWriter, parent context.Context) {
	status := http.StatusServiceUnavailable
	if h.available() {
		select {
		case h.slot <- struct{}{}:
			defer func() { <-h.slot }()
		default:
			youjiPDFError(w, 429, "busy")
			return
		}
		ctx, cancel := context.WithTimeout(parent, 10*time.Second)
		defer cancel()
		if h.modelReady(ctx) {
			status = http.StatusOK
		}
	}
	youjiPDFJSON(w, status, map[string]any{"available": status == http.StatusOK, "model": youjiRetrievalModel, "revision": youjiRetrievalRevision, "persistentIndex": false})
}

type youjiRetrievalHashReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r youjiRetrievalHashReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

func (h *youjiRetrievalHandler) modelReady(ctx context.Context) bool {
	if h.verifyModel != nil {
		return h.verifyModel(ctx)
	}
	files := []struct{ name, hash string }{
		{"model_qint8_avx512_vnni.onnx", "dd476dd0c2514e9b9be83aeb3853fac0763e0bdf4a71645407587d77c48a2d88"},
		{"tokenizer.json", "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39"},
		{"config.json", "bbb7c1333fc4b3e27fbc9cd5d2070aabcc1d4dfb99917c3633e772f97545a6b6"},
	}
	for _, file := range files {
		input, err := os.Open(filepath.Join(h.model, file.name))
		if err != nil {
			return false
		}
		hash := sha256.New()
		_, err = io.Copy(hash, youjiRetrievalHashReader{ctx, input})
		closeErr := input.Close()
		if err != nil || closeErr != nil || hex.EncodeToString(hash.Sum(nil)) != file.hash {
			return false
		}
	}
	return ctx.Err() == nil
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
	if !h.modelReady(ctx) {
		if ctx.Err() != nil {
			youjiPDFError(w, 504, "cancelled")
		} else {
			youjiPDFError(w, 503, "unavailable")
		}
		return
	}
	deadline, _ := ctx.Deadline()
	_ = http.NewResponseController(w).SetReadDeadline(deadline)
	defer func() { _ = http.NewResponseController(w).SetReadDeadline(time.Time{}) }()
	var request struct {
		Query    string `json:"query"`
		Filter   string `json:"filter"`
		Offset   int    `json:"offset"`
		Snapshot string `json:"snapshot"`
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 32<<10))
	if err != nil || !utf8.Valid(raw) || json.Unmarshal(raw, &request) != nil || strings.TrimSpace(request.Query) == "" || utf8.RuneCountInString(strings.TrimSpace(request.Query)) > 200 || len(request.Filter) > 16384 || request.Offset < 0 || request.Offset > 5000 || request.Offset%100 != 0 || len(request.Snapshot) > 64 {
		youjiPDFError(w, 422, "invalid_request")
		return
	}
	request.Query = strings.TrimSpace(request.Query)
	owner, metadata, err := h.metadata(ctx, request.Filter)
	if err != nil {
		youjiPDFError(w, 422, "candidates_unavailable")
		return
	}
	if len(metadata) > 5001 {
		metadata = metadata[:5001]
	}
	snapshot := youjiRetrievalSnapshot(owner, request.Filter, request.Query, metadata)
	if request.Offset > 0 && request.Snapshot != snapshot {
		youjiPDFError(w, 409, "results_changed")
		return
	}
	metadataTruncated := len(metadata) > 5000
	if metadataTruncated {
		metadata = metadata[:5000]
	}
	if request.Offset > len(metadata) || (request.Offset > 0 && request.Offset == len(metadata)) {
		youjiPDFError(w, 422, "invalid_request")
		return
	}
	end := min(request.Offset+100, len(metadata))
	pageIDs := make([]string, 0, end-request.Offset)
	for _, memo := range metadata[request.Offset:end] {
		pageIDs = append(pageIDs, memo.UID)
	}
	memos := []*store.Memo{}
	if len(pageIDs) > 0 {
		memos, err = h.load(ctx, request.Filter, pageIDs)
		if err != nil {
			youjiPDFError(w, 422, "candidates_unavailable")
			return
		}
	}
	pageMemos := map[string]*store.Memo{}
	for _, memo := range memos {
		pageMemos[memo.UID] = memo
	}
	memos = []*store.Memo{}
	for _, uid := range pageIDs {
		memo := pageMemos[uid]
		if memo == nil || memo.CreatorID != owner {
			youjiPDFError(w, 409, "results_changed")
			return
		}
		memos = append(memos, memo)
	}
	unchanged := func() bool {
		if len(pageIDs) > 0 {
			fresh, err := h.load(ctx, request.Filter, pageIDs)
			if err != nil {
				return false
			}
			current := map[string]*store.Memo{}
			for _, memo := range fresh {
				current[memo.UID] = memo
			}
			for _, memo := range memos {
				now := current[memo.UID]
				if now == nil || now.CreatorID != owner || now.Content != memo.Content {
					return false
				}
			}
		}
		freshOwner, freshMetadata, err := h.metadata(ctx, request.Filter)
		if err != nil {
			return false
		}
		if len(freshMetadata) > 5001 {
			freshMetadata = freshMetadata[:5001]
		}
		return freshOwner == owner && youjiRetrievalSnapshot(freshOwner, request.Filter, request.Query, freshMetadata) == snapshot
	}
	skipped := 0
	envelope := func(hits any, passageTruncated bool) map[string]any {
		candidateTruncated := end < len(metadata) || metadataTruncated || skipped > 0
		body := map[string]any{"hits": hits, "model": youjiRetrievalModel, "revision": youjiRetrievalRevision, "snapshot": snapshot, "offset": request.Offset, "scanned": end, "total": len(metadata), "skipped": skipped, "candidateTruncated": candidateTruncated, "passageTruncated": passageTruncated, "metadataTruncated": metadataTruncated, "truncated": candidateTruncated || passageTruncated}
		if end < len(metadata) {
			body["nextOffset"] = end
		}
		return body
	}
	type document struct {
		ID   string `json:"id"`
		Text string `json:"text"`
	}
	documents := []document{}
	originals := map[string]*store.Memo{}
	total := 0
	type workerInput struct {
		Query     string     `json:"query"`
		Documents []document `json:"documents"`
	}
	base, _ := json.Marshal(workerInput{request.Query, documents})
	inputBytes := len(base)
	for _, memo := range memos {
		if total+len(memo.Content) > 512<<10 {
			skipped++
			continue
		}
		name := "memos/" + memo.UID
		doc := document{ID: name, Text: memo.Content}
		encoded, _ := json.Marshal(doc)
		extra := len(encoded)
		if len(documents) > 0 {
			extra++
		}
		if inputBytes+extra > 1<<20 {
			skipped++
			continue
		}
		total += len(memo.Content)
		inputBytes += extra
		originals[name] = memo
		documents = append(documents, doc)
	}
	if len(documents) == 0 {
		if !unchanged() {
			youjiPDFError(w, 409, "results_changed")
			return
		}
		if ctx.Err() != nil {
			youjiPDFError(w, 504, "cancelled")
			return
		}
		youjiPDFJSON(w, 200, envelope([]any{}, false))
		return
	}
	input, err := json.Marshal(workerInput{request.Query, documents})
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
	for _, hit := range result.Hits {
		memo := originals[hit.ID]
		if memo == nil || seen[hit.ID] || math.IsNaN(hit.Score) || math.IsInf(hit.Score, 0) || hit.Score < -1.000001 || hit.Score > 1.000001 || hit.Excerpt == "" || len(hit.Excerpt) > 4096 || !strings.Contains(memo.Content, hit.Excerpt) {
			youjiPDFError(w, 422, "invalid_processor_output")
			return
		}
		seen[hit.ID] = true
	}
	if !unchanged() {
		youjiPDFError(w, 409, "results_changed")
		return
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
	youjiPDFJSON(w, 200, envelope(hits, result.Truncated))
}
