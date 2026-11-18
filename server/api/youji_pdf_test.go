package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/internal/profile"
)

// These controlled Python scripts test transport isolation, not real PDF extraction.
func pdfTestHandler(t *testing.T, script string) *youjiPDFHandler {
	t.Helper()
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable for controlled worker tests")
	}
	worker := filepath.Join(t.TempDir(), "worker.py")
	require.NoError(t, os.WriteFile(worker, []byte(script), 0600))
	return &youjiPDFHandler{python: python, worker: worker, slot: make(chan struct{}, 1), timeout: time.Second}
}

func pdfRequest(h *youjiPDFHandler, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/api/youji/pdf/parse", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/pdf")
	w := httptest.NewRecorder()
	h.parse(w, r, nil)
	return w
}

func TestYoujiPDFUnavailable(t *testing.T) {
	h := &youjiPDFHandler{}
	w := httptest.NewRecorder()
	h.processor(w, httptest.NewRequest(http.MethodGet, "/", nil), nil)
	require.Equal(t, 503, w.Code)
	require.Contains(t, w.Body.String(), `"available":false`)
	require.Contains(t, w.Header().Get("Cache-Control"), "no-store")
	require.Equal(t, 503, pdfRequest(h, "%PDF-test").Code)
}

func TestYoujiPDFGatewayRequiresAuthentication(t *testing.T) {
	service := &APIService{Profile: &profile.Profile{}}
	handler, err := service.NewHandler(t.Context())
	require.NoError(t, err)
	for _, endpoint := range []struct{ method, path string }{
		{http.MethodGet, "/api/youji/pdf/processor"},
		{http.MethodPost, "/api/youji/pdf/parse"},
	} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(endpoint.method, endpoint.path, nil))
		require.Equal(t, http.StatusUnauthorized, w.Code, w.Body.String())
		require.Contains(t, w.Header().Get("Cache-Control"), "no-store")
	}
}

func TestYoujiPDFValidatedOutput(t *testing.T) {
	t.Setenv("MOTEARY_API_TOKEN", "must-not-reach-worker")
	h := pdfTestHandler(t, `import json,os,sys
assert "MOTEARY_API_TOKEN" not in os.environ
assert sys.flags.isolated
assert sys.stdin.buffer.read() == b"%PDF-test"
print(json.dumps({"parser":"pypdf","version":"7.1.1","sha256":"forged","pages":[{"page":1,"text":"synthetic text"}]}))`)
	w := pdfRequest(h, "%PDF-test")
	require.Equal(t, 200, w.Code, w.Body.String())
	require.NotContains(t, w.Body.String(), "forged")
	require.Contains(t, w.Body.String(), "synthetic text")
	require.Contains(t, w.Header().Get("Cache-Control"), "no-store")
}

func TestYoujiPDFRejectsWorkerOutput(t *testing.T) {
	for _, script := range []string{
		`print("private path not JSON")`,
		`print('{"parser":"pypdf","version":"wrong","pages":[{"page":1,"text":"x"}]}')`,
		`print('{"parser":"pypdf","version":"7.1.1","pages":[{"page":2,"text":"x"}]}')`,
		`import json; print(json.dumps({"parser":"pypdf","version":"7.1.1","pages":[{"page":1,"text":"x"*262145}]}))`,
		`print('{"error":"private path"}')`,
	} {
		h := pdfTestHandler(t, script)
		w := pdfRequest(h, "%PDF-test")
		require.Equal(t, 422, w.Code)
		require.NotContains(t, w.Body.String(), "private path")
	}
}

func TestYoujiPDFInputAndBusy(t *testing.T) {
	h := pdfTestHandler(t, `raise RuntimeError("must not execute")`)
	require.Equal(t, 413, pdfRequest(h, "%PDF-"+strings.Repeat("x", 16<<20)).Code)
	require.Equal(t, 422, pdfRequest(h, "not pdf").Code)
	h.slot <- struct{}{}
	require.Equal(t, 429, pdfRequest(h, "%PDF-test").Code)
	<-h.slot
}

func TestYoujiPDFCancellationAndOutputLimit(t *testing.T) {
	for _, script := range []string{`import time; time.sleep(10)`, `import sys; sys.stdout.write("x"*3000000); sys.stdout.flush()`} {
		h := pdfTestHandler(t, script)
		h.timeout = 100 * time.Millisecond
		start := time.Now()
		w := pdfRequest(h, "%PDF-test")
		require.Equal(t, 504, w.Code)
		require.Less(t, time.Since(start), 2*time.Second)
		require.Empty(t, h.slot)
	}
	h := pdfTestHandler(t, `import time; time.sleep(10)`)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("%PDF-test")).WithContext(ctx)
	r.Header.Set("Content-Type", "application/pdf")
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		h.parse(w, r, nil)
		close(done)
	}()
	require.Eventually(t, func() bool { return len(h.slot) == 1 }, time.Second, time.Millisecond)
	require.Equal(t, 429, pdfRequest(h, "%PDF-test").Code)
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled worker did not finish")
	}
	require.Equal(t, 504, w.Code)
	require.Empty(t, h.slot)
}
