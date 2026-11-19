package api

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/usememos/memos/server/auth"
	"github.com/usememos/memos/store"
)

func TestYoujiAudioImportIdentityMatchesFrontend(t *testing.T) {
	for _, tc := range []struct{ name, id string }{
		{"合成录音.wav", "mwa-5c2a12a8d2c4fb1c871cc6cd945a8b"},
		{"<合成&>\u2028.MP3", "mwa-d3c625a059b2258fd72f83ba10b00c"},
		{`literal\u2028.ogg`, "mwa-2b85f0b591219826d8873d6d81c7e0"},
	} {
		id, sum := youjiTextIdentity(audioOriginalSpec(), "users/42", tc.name, []byte{0x52, 0x49, 0x46, 0x46, 0, 0xff, 0x80, 10})
		require.Equal(t, tc.id, id)
		require.Equal(t, "c7b0a8d4bf0700bf5c2930f0074d036830493725763e9487c99045c3e2aa5bed", sum)
		manual, _ := youjiManualIdentity("users/42", tc.name, []byte{0x52, 0x49, 0x46, 0x46, 0, 0xff, 0x80, 10})
		require.NotEqual(t, strings.TrimPrefix(manual, "mwt-"), strings.TrimPrefix(id, "mwa-"))
		other, _ := youjiTextIdentity(audioOriginalSpec(), "users/43", tc.name, []byte{0x52, 0x49, 0x46, 0x46, 0, 0xff, 0x80, 10})
		require.NotEqual(t, id, other)
	}
}

func TestYoujiAudioImportArchiveOriginalOnlyAndLimits(t *testing.T) {
	input := youjiManualRequest{Filename: "合成.WAV", Content: "人工核对文字", Data: []byte{0x52, 0x49, 0x46, 0x46, 0, 0xff, 0x80, 10}}
	first, err := youjiTextArchive(audioOriginalSpec(), input)
	require.NoError(t, err)
	second, err := youjiTextArchive(audioOriginalSpec(), input)
	require.NoError(t, err)
	require.Equal(t, first, second)
	reader, err := zip.NewReader(bytes.NewReader(first), int64(len(first)))
	require.NoError(t, err)
	require.Len(t, reader.File, 1)
	require.Equal(t, input.Filename, reader.File[0].Name)
	require.Equal(t, uint16(zip.Store), reader.File[0].Method)
	entry, err := reader.File[0].Open()
	require.NoError(t, err)
	defer entry.Close()
	raw, err := io.ReadAll(entry)
	require.NoError(t, err)
	require.Equal(t, input.Data, raw)
	for _, name := range []string{"a.wav", "a.MP3", "a.ogg", "a.m4a", "a.flac", "a.webm"} {
		copy := input
		copy.Filename = name
		_, err := youjiTextArchive(audioOriginalSpec(), copy)
		require.NoError(t, err)
	}
	for _, name := range []string{"a.txt", "a.md", "a.html", "a.json", "a.wav.zip", "../a.wav", `dir\a.wav`, "a\n.wav", ".a.wav", " a.wav", "a\x7f.wav", "", strings.Repeat("a", 241) + ".wav"} {
		copy := input
		copy.Filename = name
		_, err := youjiTextArchive(audioOriginalSpec(), copy)
		require.Error(t, err, name)
	}
	for _, data := range [][]byte{nil, bytes.Repeat([]byte{0xff}, (16<<20)+1)} {
		copy := input
		copy.Data = data
		_, err := youjiTextArchive(audioOriginalSpec(), copy)
		require.Error(t, err)
	}
	for _, content := range []string{"", string([]byte{0xff}), strings.Repeat("x", (256<<10)+1)} {
		copy := input
		copy.Content = content
		_, err := youjiTextArchive(audioOriginalSpec(), copy)
		require.Error(t, err)
	}
	input.Data = bytes.Repeat([]byte{0xff}, 16<<20)
	input.Content = strings.Repeat("x", 256<<10)
	_, err = youjiTextArchive(audioOriginalSpec(), input)
	require.NoError(t, err)
	_, err = youjiManualArchive(input)
	require.Error(t, err, "manual route must not accept audio or its larger limit")
}

func TestYoujiAudioImportGatewayAtomicImportAndFixedKind(t *testing.T) {
	svc, ctx := newUploadTestService(t)
	user, err := svc.fetchCurrentUser(ctx)
	require.NoError(t, err)
	token, _, err := auth.GenerateAccessTokenV2(user.ID, user.Username, string(user.Role), string(user.RowStatus), user.PasswordHash, []byte(svc.Secret))
	require.NoError(t, err)
	handler, err := svc.NewHandler(ctx)
	require.NoError(t, err)
	call := func(path string, body []byte, authenticated bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if authenticated {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}
	route := "/api/youji/audio-original/import"
	input := youjiManualRequest{Owner: BuildUserName(user.Username), Filename: "synthetic.wav", Content: "# synthetic\n可检索正文", Data: []byte{0x52, 0x49, 0x46, 0x46, 0, 0xff, 0x80, 10}}
	body, err := json.Marshal(input)
	require.NoError(t, err)
	require.Equal(t, 401, call(route, body, false).Code)
	rec := call(route, body, true)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	require.Contains(t, rec.Header().Get("Cache-Control"), "no-store")
	var result map[string]string
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &result))
	id, sum := youjiTextIdentity(audioOriginalSpec(), input.Owner, input.Filename, input.Data)
	require.Equal(t, map[string]string{"memo": "memos/" + id, "attachment": "attachments/yma-" + strings.TrimPrefix(id, "mwa-"), "sha256": sum, "status": "imported"}, result)
	rec = call(route, body, true)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), `"verified"`)
	copy := input
	copy.Content = "edited same original"
	changed, _ := json.Marshal(copy)
	require.Equal(t, 409, call(route, changed, true).Code)
	copy = input
	copy.Owner = "users/other"
	changed, _ = json.Marshal(copy)
	require.Equal(t, 403, call(route, changed, true).Code)
	for _, field := range []string{"kind", "visibility", "id", "attachment"} {
		forged := append(append([]byte{}, body[:len(body)-1]...), []byte(`,"`+field+`":"manual-text-v1"}`)...)
		require.Equal(t, 422, call(route, forged, true).Code, field)
	}
	require.Equal(t, 422, call("/api/youji/manual-text/import", body, true).Code)
	require.Equal(t, 422, call("/api/youji/html-text/import", body, true).Code)
	require.Equal(t, 422, call("/api/youji/chat-json/import", body, true).Code)
	copy = input
	copy.Filename = "synthetic.txt"
	changed, _ = json.Marshal(copy)
	require.Equal(t, 422, call(route, changed, true).Code)
	require.Equal(t, 422, call(route, append(body, []byte(`{}`)...), true).Code)
	memos, err := svc.Store.ListMemos(ctx, &store.FindMemo{CreatorID: &user.ID})
	require.NoError(t, err)
	require.Len(t, memos, 1)
	require.Equal(t, store.Private, memos[0].Visibility)
	attachments, err := svc.Store.ListAttachments(ctx, &store.FindAttachment{CreatorID: &user.ID, GetBlob: true})
	require.NoError(t, err)
	require.Len(t, attachments, 1)
	require.Equal(t, memos[0].ID, *attachments[0].MemoID)
	require.Equal(t, "application/zip", attachments[0].Type)
	expected, err := youjiTextArchive(audioOriginalSpec(), input)
	require.NoError(t, err)
	require.Equal(t, expected, attachments[0].Blob)
}

// Produces whitespace without allocating a request-sized source buffer.
type audioImportSpaces struct{}

func (audioImportSpaces) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = ' '
	}
	return len(p), nil
}

func TestYoujiAudioImportRequestBudgetAndQuota(t *testing.T) {
	spec := audioOriginalSpec()
	// Base64 expansion + worst-case JSON string escaping + bounded owner/filename/metadata.
	require.Less(t, ((spec.rawLimit+2)/3)*4+6*(256<<10)+8192, spec.requestLimit)
	require.EqualValues(t, 24<<20, spec.requestLimit)
	svc, ctx := newUploadTestService(t)
	user, err := svc.fetchCurrentUser(ctx)
	require.NoError(t, err)
	input := youjiManualRequest{Owner: BuildUserName(user.Username), Filename: "quota.wav", Content: strings.Repeat("a", int(store.DefaultMemoContentBytes)+1), Data: []byte{0xff, 0x80}}
	body, err := json.Marshal(input)
	require.NoError(t, err)
	rec := httptest.NewRecorder()
	svc.importYoujiAudioOriginal(rec, httptest.NewRequest("POST", "/api/youji/audio-original/import", bytes.NewReader(body)).WithContext(ctx), nil)
	require.Equal(t, 422, rec.Code)
	require.Contains(t, rec.Body.String(), "invalid_content_or_content_quota")
	rec = httptest.NewRecorder()
	// MaxBytesReader must stop this stream before an unlimited decoder can read forever.
	source := &uploadCountingReader{reader: audioImportSpaces{}}
	svc.importYoujiAudioOriginal(rec, httptest.NewRequest("POST", "/api/youji/audio-original/import", source).WithContext(ctx), nil)
	require.Equal(t, 422, rec.Code)
	require.Contains(t, rec.Body.String(), "invalid_input")
	require.LessOrEqual(t, int64(source.read), spec.requestLimit+1)
	memos, err := svc.Store.ListMemos(ctx, &store.FindMemo{CreatorID: &user.ID})
	require.NoError(t, err)
	require.Empty(t, memos)
	attachments, err := svc.Store.ListAttachments(ctx, &store.FindAttachment{CreatorID: &user.ID})
	require.NoError(t, err)
	require.Empty(t, attachments)
}

func TestYoujiAudioImportDoesNotRelaxTextUTF8(t *testing.T) {
	for _, spec := range []youjiTextSpec{manualTextSpec(), htmlTextSpec(), chatTextSpec()} {
		_, err := youjiTextArchive(spec, youjiManualRequest{Filename: "synthetic" + spec.extensions[0], Content: "valid text", Data: []byte{0xff, 0x80}})
		require.Error(t, err, spec.domain)
	}
	for _, input := range []youjiManualRequest{
		{Filename: "synthetic.wav", Content: string([]byte{0xff}), Data: []byte{0xff}},
		{Filename: string([]byte{0xff}) + ".wav", Content: "text", Data: []byte{0xff}},
	} {
		_, err := youjiTextArchive(audioOriginalSpec(), input)
		require.Error(t, err)
	}
}

func TestYoujiAudioImportUnsupportedDriverFailsClosed(t *testing.T) {
	svc, ctx := newUploadTestService(t)
	original := svc.Store
	svc.Store = store.New(youjiNonAtomicDriver{original.GetDriver()}, svc.Profile)
	for _, handler := range []func(http.ResponseWriter, *http.Request, map[string]string){svc.importYoujiAudioOriginal} {
		rec := httptest.NewRecorder()
		handler(rec, httptest.NewRequest("POST", "/", strings.NewReader(`{}`)).WithContext(ctx), nil)
		require.Equal(t, 501, rec.Code)
		require.Contains(t, rec.Body.String(), "sqlite_manual_import_required")
	}
	memos, err := original.ListMemos(ctx, &store.FindMemo{})
	require.NoError(t, err)
	require.Empty(t, memos)
	attachments, err := original.ListAttachments(ctx, &store.FindAttachment{})
	require.NoError(t, err)
	require.Empty(t, attachments)
}
