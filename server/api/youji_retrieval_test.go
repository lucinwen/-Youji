package api

import (
	"context"
	"encoding/json"
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
	return &youjiRetrievalHandler{python: pdf.python, worker: pdf.worker, model: model, slot: make(chan struct{}, 1), timeout: time.Second,
		load: func(context.Context, string, []string) ([]*store.Memo, error) {
			return []*store.Memo{{UID: "synthetic-id", CreatorID: 42, Content: "synthetic private material"}}, nil
		},
	}
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
	require.Equal(t, 2, calls)
	require.Contains(t, w.Body.String(), `"name":"memos/synthetic-id"`)
	require.Contains(t, w.Body.String(), `"truncated":true`)
	require.NotContains(t, w.Body.String(), "private material")
	require.Contains(t, w.Header().Get("Cache-Control"), "no-store")
}

func TestYoujiRetrievalDropsChangedResults(t *testing.T) {
	for _, change := range []string{"deleted", "edited", "owner"} {
		t.Run(change, func(t *testing.T) {
			h := retrievalTestHandler(t, retrievalTestWorker)
			h.load = func(_ context.Context, _ string, ids []string) ([]*store.Memo, error) {
				memo := &store.Memo{UID: "synthetic-id", CreatorID: 42, Content: "synthetic private material"}
				if len(ids) > 0 {
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
		return []*store.Memo{{UID: "huge", Content: strings.Repeat("x", (1<<20)+1)}}, nil
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
		return []*store.Memo{{UID: "escaped", Content: strings.Repeat("<", 200000)}}, nil
	}
	require.Equal(t, 413, retrievalRequest(h, `{"query":"find"}`).Code)
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
