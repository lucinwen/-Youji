package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/internal/profile"
	"github.com/usememos/memos/store"
)

const retrievalTestWorker = `import json,os,sys
assert "MOTEARY_API_TOKEN" not in os.environ
assert sys.flags.isolated and sys.argv[1] == "--model-dir"
d=json.load(sys.stdin)
print(json.dumps({"hits":[{"id":d["documents"][0]["id"],"score":0.8,"excerpt":"synthetic"}],"model":"intfloat/multilingual-e5-small","revision":"614241f622f53c4eeff9890bdc4f31cfecc418b3","truncated":True}))`

func retrievalTestHandler(t *testing.T, script string) *youjiRetrievalHandler {
	t.Helper()
	pdf := pdfTestHandler(t, script)
	model := t.TempDir()
	for _, name := range []string{"model_qint8_avx512_vnni.onnx", "tokenizer.json", "config.json"} {
		require.NoError(t, os.WriteFile(filepath.Join(model, name), []byte("controlled test placeholder; not a model"), 0600))
	}
	h := &youjiRetrievalHandler{python: pdf.python, worker: pdf.worker, model: model, slot: make(chan struct{}, 1), timeout: time.Second,
		verifyModel: func(context.Context) bool { return true },
		load: func(context.Context, string, []string) ([]*store.Memo, error) {
			return []*store.Memo{{UID: "synthetic-id", CreatorID: 42, Content: "synthetic private material"}}, nil
		},
	}
	h.metadata = func(ctx context.Context, filter string) (int32, []*store.Memo, error) {
		memos, err := h.load(ctx, filter, nil)
		return 42, memos, err
	}
	return h
}

func retrievalRequest(h *youjiRetrievalHandler, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/api/youji/retrieval/search", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.search(w, r, nil)
	return w
}

func TestYoujiRetrievalFindEnforcesOwner(t *testing.T) {
	scope := &store.MemoAccessScope{AllowPublic: true, AllowProtected: true}
	find := youjiRetrievalFind(42, scope, `creator == "users/other" || true`, []string{"only-this"})
	require.EqualValues(t, 42, *find.CreatorID)
	require.Same(t, scope, find.Access)
	require.Equal(t, store.Normal, *find.RowStatus)
	require.True(t, find.ExcludeComments)
	require.Equal(t, []string{"only-this"}, find.UIDList)
	require.Equal(t, 101, *find.Limit)
}

func TestYoujiRetrievalGatewayAndUnavailable(t *testing.T) {
	service := &APIService{Profile: &profile.Profile{}}
	handler, err := service.NewHandler(t.Context())
	require.NoError(t, err)
	for _, route := range []struct{ method, path string }{{"GET", "/api/youji/retrieval/processor"}, {"POST", "/api/youji/retrieval/search"}} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(route.method, route.path, nil))
		require.Equal(t, 401, w.Code)
		require.Contains(t, w.Header().Get("Cache-Control"), "no-store")
	}
	h := &youjiRetrievalHandler{}
	w := httptest.NewRecorder()
	h.processor(w, httptest.NewRequest("GET", "/", nil), nil)
	require.Equal(t, 503, w.Code)
	require.Contains(t, w.Body.String(), `"available":false`)
	require.Equal(t, 503, retrievalRequest(h, `{"query":"x"}`).Code)
}

func TestYoujiRetrievalControlledWorker(t *testing.T) {
	t.Setenv("MOTEARY_API_TOKEN", "must-not-reach-worker")
	h := retrievalTestHandler(t, retrievalTestWorker)
	calls := 0
	h.load = func(_ context.Context, filter string, ids []string) ([]*store.Memo, error) {
		calls++
		require.Equal(t, `tag in ["拾微"]`, filter)
		if calls == 2 {
			require.Equal(t, []string{"synthetic-id"}, ids)
		}
		return []*store.Memo{{UID: "synthetic-id", CreatorID: 42, Content: "synthetic private material"}}, nil
	}
	w := retrievalRequest(h, `{"query":"find","filter":"tag in [\"拾微\"]"}`)
	require.Equal(t, 200, w.Code, w.Body.String())
	require.Equal(t, 4, calls)
	require.Contains(t, w.Body.String(), `"name":"memos/synthetic-id"`)
	require.Contains(t, w.Body.String(), `"truncated":true`)
	require.NotContains(t, w.Body.String(), "private material")
	require.Contains(t, w.Header().Get("Cache-Control"), "no-store")
}

func TestYoujiRetrievalDropsChangedResults(t *testing.T) {
	for _, change := range []string{"deleted", "edited", "owner"} {
		t.Run(change, func(t *testing.T) {
			h := retrievalTestHandler(t, retrievalTestWorker)
			bodyCalls := 0
			h.load = func(_ context.Context, _ string, ids []string) ([]*store.Memo, error) {
				memo := &store.Memo{UID: "synthetic-id", CreatorID: 42, Content: "synthetic private material"}
				if len(ids) > 0 {
					bodyCalls++
				}
				if bodyCalls > 1 && len(ids) > 0 {
					switch change {
					case "deleted":
						return nil, nil
					case "edited":
						memo.Content = "new"
					case "owner":
						memo.CreatorID = 43
					}
				}
				return []*store.Memo{memo}, nil
			}
			w := retrievalRequest(h, `{"query":"find"}`)
			require.Equal(t, 409, w.Code)
			require.NotContains(t, w.Body.String(), "synthetic")
		})
	}
}

func TestYoujiRetrievalRejectsUngroundedWorker(t *testing.T) {
	for _, script := range []string{
		`print("private path")`,
		strings.Replace(retrievalTestWorker, `"score":0.8`, `"score":999`, 1),
		strings.Replace(retrievalTestWorker, `"excerpt":"synthetic"`, `"excerpt":"invented"`, 1),
		strings.Replace(retrievalTestWorker, `d["documents"][0]["id"]`, `"memos/other-account"`, 1),
		strings.Replace(retrievalTestWorker, youjiRetrievalRevision, "unapproved-revision", 1),
	} {
		w := retrievalRequest(retrievalTestHandler(t, script), `{"query":"find"}`)
		require.Equal(t, 422, w.Code)
		require.NotContains(t, w.Body.String(), "private path")
	}
}

func TestYoujiRetrievalBoundsAndCancellation(t *testing.T) {
	h := retrievalTestHandler(t, retrievalTestWorker)
	for _, body := range []string{`{}`, `{"query":" "}`, strings.Repeat("x", 33000)} {
		require.Equal(t, 422, retrievalRequest(h, body).Code)
	}
	query, err := json.Marshal(map[string]string{"query": strings.Repeat("问", 201)})
	require.NoError(t, err)
	require.Equal(t, 422, retrievalRequest(h, string(query)).Code)
	h.slot <- struct{}{}
	require.Equal(t, 429, retrievalRequest(h, `{"query":"find"}`).Code)
	<-h.slot
	h.load = func(context.Context, string, []string) ([]*store.Memo, error) {
		return []*store.Memo{{UID: "huge", CreatorID: 42, Content: strings.Repeat("x", (1<<20)+1)}}, nil
	}
	w := retrievalRequest(h, `{"query":"find"}`)
	require.Equal(t, 200, w.Code)
	var result struct {
		Truncated bool
		Hits      []any
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &result))
	require.True(t, result.Truncated)
	require.Empty(t, result.Hits)
	h.load = func(context.Context, string, []string) ([]*store.Memo, error) {
		return []*store.Memo{{UID: "escaped", CreatorID: 42, Content: strings.Repeat("<", 200000)}}, nil
	}
	w = retrievalRequest(h, `{"query":"find"}`)
	require.Equal(t, 200, w.Code)
	require.Contains(t, w.Body.String(), `"skipped":1`)
	require.NoError(t, os.Remove(filepath.Join(h.model, "tokenizer.json")))
	require.False(t, h.available())
	for _, script := range []string{`import time;time.sleep(10)`, `import sys;sys.stdout.write("x"*3000000);sys.stdout.flush()`} {
		h := retrievalTestHandler(t, script)
		h.timeout = 100 * time.Millisecond
		start := time.Now()
		require.Equal(t, 504, retrievalRequest(h, `{"query":"find"}`).Code)
		require.Less(t, time.Since(start), 2*time.Second)
		require.Empty(t, h.slot)
	}
}

func retrievalDataset(h *youjiRetrievalHandler, rows []*store.Memo) {
	h.metadata = func(context.Context, string) (int32, []*store.Memo, error) {
		result := []*store.Memo{}
		for _, row := range rows {
			copy := *row
			copy.Content = ""
			result = append(result, &copy)
		}
		return 42, result, nil
	}
	h.load = func(_ context.Context, _ string, ids []string) ([]*store.Memo, error) {
		wanted := map[string]bool{}
		for _, id := range ids {
			wanted[id] = true
		}
		result := []*store.Memo{}
		for _, row := range rows {
			if wanted[row.UID] {
				copy := *row
				result = append(result, &copy)
			}
		}
		return result, nil
	}
}

func retrievalRows(count int) []*store.Memo {
	rows := make([]*store.Memo, count)
	for i := range rows {
		rows[i] = &store.Memo{ID: int32(i + 1), UID: fmt.Sprintf("row-%04d", i), CreatorID: 42, Content: "synthetic material", CreatedTs: int64(count - i), UpdatedTs: 1, RowStatus: store.Normal, Visibility: store.Private}
	}
	return rows
}

type retrievalPage struct {
	Snapshot                                                string
	NextOffset                                              *int
	Scanned, Total, Skipped                                 int
	MetadataTruncated, CandidateTruncated, PassageTruncated bool
	Hits                                                    []struct{ Name string }
}

func retrievalPageRequest(t *testing.T, h *youjiRetrievalHandler, offset int, snapshot string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]any{"query": "find", "filter": "", "offset": offset, "snapshot": snapshot})
	require.NoError(t, err)
	return retrievalRequest(h, string(body))
}

func decodeRetrievalPage(t *testing.T, w *httptest.ResponseRecorder) retrievalPage {
	t.Helper()
	require.Equal(t, 200, w.Code, w.Body.String())
	var page retrievalPage
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &page))
	return page
}

func TestYoujiRetrievalPagination(t *testing.T) {
	h := retrievalTestHandler(t, retrievalTestWorker)
	retrievalDataset(h, retrievalRows(201))
	first := decodeRetrievalPage(t, retrievalPageRequest(t, h, 0, ""))
	require.Equal(t, 201, first.Total)
	require.Equal(t, 100, first.Scanned)
	require.Equal(t, 100, *first.NextOffset)
	require.Equal(t, "memos/row-0000", first.Hits[0].Name)
	second := decodeRetrievalPage(t, retrievalPageRequest(t, h, 100, first.Snapshot))
	require.Equal(t, first.Snapshot, second.Snapshot)
	require.Equal(t, 200, second.Scanned)
	require.Equal(t, "memos/row-0100", second.Hits[0].Name)
	last := decodeRetrievalPage(t, retrievalPageRequest(t, h, 200, first.Snapshot))
	require.Equal(t, 201, last.Scanned)
	require.Nil(t, last.NextOffset)
	require.False(t, last.CandidateTruncated)
	require.True(t, last.PassageTruncated)
	require.Equal(t, 409, retrievalPageRequest(t, h, 100, "").Code)
	require.Equal(t, 409, retrievalPageRequest(t, h, 100, strings.Repeat("0", 64)).Code)
	require.Equal(t, 422, retrievalPageRequest(t, h, 1, first.Snapshot).Code)
	for _, field := range []string{"query", "filter"} {
		body, err := json.Marshal(map[string]any{"query": "find", "offset": 100, "snapshot": first.Snapshot, field: "changed"})
		require.NoError(t, err)
		require.Equal(t, 409, retrievalRequest(h, string(body)).Code)
	}
}

func TestYoujiRetrievalSnapshotChanges(t *testing.T) {
	for _, change := range []string{"insert", "delete", "visibility", "updated", "owner"} {
		t.Run(change, func(t *testing.T) {
			h := retrievalTestHandler(t, retrievalTestWorker)
			rows := retrievalRows(101)
			retrievalDataset(h, rows)
			first := decodeRetrievalPage(t, retrievalPageRequest(t, h, 0, ""))
			switch change {
			case "insert":
				rows = append([]*store.Memo{{ID: 999, UID: "new", CreatorID: 42, Content: "synthetic"}}, rows...)
			case "delete":
				rows = rows[1:]
			case "visibility":
				rows[100].Visibility = store.Public
			case "updated":
				rows[100].UpdatedTs++
			case "owner":
				rows[100].CreatorID = 43
			}
			retrievalDataset(h, rows)
			require.Equal(t, 409, retrievalPageRequest(t, h, 100, first.Snapshot).Code)
		})
	}
}

func TestYoujiRetrievalMetadataCapAndOversizeProgress(t *testing.T) {
	h := retrievalTestHandler(t, retrievalTestWorker)
	retrievalDataset(h, retrievalRows(5002))
	first := decodeRetrievalPage(t, retrievalPageRequest(t, h, 0, ""))
	require.Equal(t, 5000, first.Total)
	require.True(t, first.MetadataTruncated)
	last := decodeRetrievalPage(t, retrievalPageRequest(t, h, 4900, first.Snapshot))
	require.Equal(t, 5000, last.Scanned)
	require.Nil(t, last.NextOffset)
	require.True(t, last.CandidateTruncated)
	rows := retrievalRows(101)
	oversize := strings.Repeat("x", (512<<10)+1)
	for _, row := range rows[:100] {
		row.Content = oversize
	}
	retrievalDataset(h, rows)
	skipped := decodeRetrievalPage(t, retrievalPageRequest(t, h, 0, ""))
	require.Equal(t, 100, skipped.Skipped)
	require.Empty(t, skipped.Hits)
	require.Equal(t, 100, *skipped.NextOffset)
	remaining := decodeRetrievalPage(t, retrievalPageRequest(t, h, 100, skipped.Snapshot))
	require.Equal(t, "memos/row-0100", remaining.Hits[0].Name)
}

func TestYoujiRetrievalRechecksEntirePageAndMetadata(t *testing.T) {
	for _, change := range []string{"nonhit_content", "metadata"} {
		t.Run(change, func(t *testing.T) {
			h := retrievalTestHandler(t, retrievalTestWorker)
			rows := retrievalRows(2)
			retrievalDataset(h, rows)
			load := h.load
			calls := 0
			h.load = func(ctx context.Context, filter string, ids []string) ([]*store.Memo, error) {
				calls++
				if calls == 2 {
					if change == "nonhit_content" {
						rows[1].Content = "changed in same second"
					} else {
						rows[1].Pinned = true
					}
				}
				return load(ctx, filter, ids)
			}
			w := retrievalPageRequest(t, h, 0, "")
			require.Equal(t, 409, w.Code)
			require.NotContains(t, w.Body.String(), "synthetic")
		})
	}
}

func TestYoujiRetrievalStatusHashesModel(t *testing.T) {
	h := retrievalTestHandler(t, retrievalTestWorker)
	h.verifyModel = nil // Nonempty placeholder files must fail the production hash check.
	w := httptest.NewRecorder()
	h.processor(w, httptest.NewRequest("GET", "/", nil), nil)
	require.Equal(t, 503, w.Code)
	require.Contains(t, w.Body.String(), `"available":false`)
	require.Equal(t, 503, retrievalPageRequest(t, h, 0, "").Code)
	h.slot <- struct{}{}
	w = httptest.NewRecorder()
	h.processor(w, httptest.NewRequest("GET", "/", nil), nil)
	require.Equal(t, 429, w.Code)
	<-h.slot
}

func TestYoujiRetrievalHashCancellation(t *testing.T) {
	h := retrievalTestHandler(t, retrievalTestWorker)
	h.timeout = 20 * time.Millisecond
	h.verifyModel = func(ctx context.Context) bool { <-ctx.Done(); return false }
	w := retrievalPageRequest(t, h, 0, "")
	require.Equal(t, 504, w.Code)
	require.Contains(t, w.Body.String(), "cancelled")
	require.Empty(t, h.slot)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	reader := youjiRetrievalHashReader{ctx, strings.NewReader("private model bytes")}
	_, err := reader.Read(make([]byte, 8))
	require.ErrorIs(t, err, context.Canceled)
}
