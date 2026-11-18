package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/internal/profile"
)

// Controlled transport fixture, not a real ASR engine or accuracy test.
const audioTestWorker = `import hashlib,json,os,sys
assert sys.flags.isolated and sys.argv[1] == "--model-dir"
assert "MOTEARY_API_TOKEN" not in os.environ
result={"engine":"faster-whisper","model":"Systran/faster-whisper-tiny","revision":"d90ca5fe260221311c53c58e660288d3deb8d356","language":"zh"}
if "--check" in sys.argv:
 result["available"]=True
else:
 raw=sys.stdin.buffer.read()
 result.update({"sha256":hashlib.sha256(raw).hexdigest(),"duration":1,"segments":[{"start":0,"end":1,"text":"合成内容"}],"text":"合成内容"})
print(json.dumps(result))`

func audioTestHandler(t *testing.T, script string) *youjiAudioHandler {
	t.Helper()
	pdf := pdfTestHandler(t, script)
	model := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(model, "manifest.json"), []byte(`{"fixture":"controlled fake worker only"}`), 0600))
	return &youjiAudioHandler{python: pdf.python, worker: pdf.worker, model: model, slot: make(chan struct{}, 1), timeout: time.Second, checkTimeout: time.Second}
}

func audioRequest(h *youjiAudioHandler, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/api/youji/audio/transcribe", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/octet-stream")
	w := httptest.NewRecorder()
	h.transcribe(w, r, nil)
	return w
}

func TestYoujiAudioGatewayRequiresAuthentication(t *testing.T) {
	service := &APIService{Profile: &profile.Profile{}}
	handler, err := service.NewHandler(t.Context())
	require.NoError(t, err)
	for _, route := range []struct{ method, path string }{{"GET", "/api/youji/audio/processor"}, {"POST", "/api/youji/audio/transcribe"}} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(route.method, route.path, nil))
		require.Equal(t, 401, w.Code, w.Body.String())
		require.Contains(t, w.Header().Get("Cache-Control"), "no-store")
	}
}

func TestYoujiAudioUnavailableAndHealth(t *testing.T) {
	h := &youjiAudioHandler{}
	w := httptest.NewRecorder()
	h.processor(w, httptest.NewRequest("GET", "/", nil), nil)
	require.Equal(t, 503, w.Code)
	require.JSONEq(t, `{"error":"unavailable"}`, w.Body.String())
	require.Equal(t, 503, audioRequest(h, "synthetic").Code)
	h = audioTestHandler(t, audioTestWorker)
	w = httptest.NewRecorder()
	h.processor(w, httptest.NewRequest("GET", "/", nil), nil)
	require.Equal(t, 200, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"available":true`)
	require.Contains(t, w.Body.String(), `"language":"zh"`)
	require.NotContains(t, w.Body.String(), h.model)
	require.NotContains(t, w.Body.String(), "segments")
	require.Contains(t, w.Header().Get("Cache-Control"), "no-store")
	require.NoError(t, os.Remove(filepath.Join(h.model, "manifest.json")))
	require.Equal(t, 503, audioRequest(h, "synthetic").Code)
}

func TestYoujiAudioControlledResult(t *testing.T) {
	t.Setenv("MOTEARY_API_TOKEN", "never-forward-this")
	h := audioTestHandler(t, audioTestWorker)
	w := audioRequest(h, "synthetic bytes")
	require.Equal(t, 200, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "合成内容")
	require.NotContains(t, w.Body.String(), "available")
	require.Contains(t, w.Header().Get("Cache-Control"), "no-store")
	require.Equal(t, 422, audioRequest(h, "").Code)
	require.Equal(t, 413, audioRequest(h, strings.Repeat("x", (16<<20)+1)).Code)
}

func TestYoujiAudioRejectsInvalidWorkerResults(t *testing.T) {
	for _, modify := range []string{
		`result["sha256"]="forged"`,
		`result["duration"]=121`,
		`result["segments"][0]["start"]=-1`,
		`result["segments"][0]["end"]=1000`,
		`result["text"]="inconsistent"`,
		`result["segments"]=[]`,
	} {
		script := strings.Replace(audioTestWorker, "print(json.dumps(result))", modify+"\nprint(json.dumps(result))", 1)
		w := audioRequest(audioTestHandler(t, script), "synthetic")
		require.Equal(t, 422, w.Code, w.Body.String())
		require.JSONEq(t, `{"error":"invalid_audio"}`, w.Body.String())
	}
	for _, script := range []string{`print("private decoder details")`, strings.Replace(audioTestWorker, "Systran/faster-whisper-tiny", "unknown-model", 1)} {
		w := audioRequest(audioTestHandler(t, script), "synthetic")
		require.Equal(t, 503, w.Code)
		require.NotContains(t, w.Body.String(), "private decoder")
	}
	for _, code := range []string{"invalid_audio", "no_speech", "too_long"} {
		w := audioRequest(audioTestHandler(t, `print('{"error":"`+code+`"}')`), "synthetic")
		require.Equal(t, 422, w.Code)
		require.JSONEq(t, `{"error":"`+code+`"}`, w.Body.String())
	}
}

func TestYoujiAudioTimeoutOutputLimitAndCancellation(t *testing.T) {
	for _, script := range []string{`import time;time.sleep(10)`, `import sys;sys.stdout.write("x"*3000000);sys.stdout.flush()`} {
		h := audioTestHandler(t, script)
		h.timeout = 100 * time.Millisecond
		start := time.Now()
		w := audioRequest(h, "synthetic")
		require.Equal(t, 504, w.Code)
		require.Less(t, time.Since(start), 2*time.Second)
		require.Empty(t, h.slot)
	}
	h := audioTestHandler(t, `import time;time.sleep(10)`)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	r := httptest.NewRequest("POST", "/", strings.NewReader("synthetic")).WithContext(ctx)
	r.Header.Set("Content-Type", "application/octet-stream")
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { h.transcribe(w, r, nil); close(done) }()
	require.Eventually(t, func() bool { return len(h.slot) == 1 }, time.Second, time.Millisecond)
	busy := httptest.NewRecorder()
	h.processor(busy, httptest.NewRequest("GET", "/", nil), nil)
	require.Equal(t, 429, busy.Code)
	require.Equal(t, 429, audioRequest(h, "synthetic").Code)
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled worker did not exit")
	}
	require.Equal(t, 504, w.Code)
	require.Empty(t, h.slot)
}
