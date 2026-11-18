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
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/server/auth"
	"github.com/usememos/memos/store"
)

func TestYoujiChatIdentityMatchesFrontend(t *testing.T) {
	for _, tc := range []struct{ name, id string }{
		{"合成聊天.json", "mwc-cd7f22076a867613577f02ab31ed1a"},
		{"<合成&>\u2028.JSON", "mwc-577cd383fff31bac009aa124c0d6df"},
		{`literal\u2028.json`, "mwc-c7415d31c2996452273d38a2fae836"},
	} {
		id, sum := youjiTextIdentity(chatTextSpec(), "users/42", tc.name, []byte("{\"name\":\"合成\",\"messages\":[]}\r\n"))
		require.Equal(t, tc.id, id)
		require.Equal(t, "94934e53e0e29fac5621bc66c79954b4a5b8d9d058c0423a37f077e8a8c61eaa", sum)
		manual, _ := youjiManualIdentity("users/42", tc.name, []byte("{\"name\":\"合成\",\"messages\":[]}\r\n"))
		require.NotEqual(t, strings.TrimPrefix(manual, "mwt-"), strings.TrimPrefix(id, "mwc-"))
		other, _ := youjiTextIdentity(chatTextSpec(), "users/43", tc.name, []byte("{\"name\":\"合成\",\"messages\":[]}\r\n"))
		require.NotEqual(t, id, other)
	}
}

func TestYoujiChatArchiveOriginalOnlyAndLimits(t *testing.T) {
	input := youjiManualRequest{Filename: "合成.JSON", Content: "人工核对的纯文字", Data: []byte("\xef\xbb\xbf{\"name\":\"合成\",\"messages\":[{\"text\":\"<script>fetch(https://example.invalid)</script>\"}]}\r\n")}
	first, err := youjiTextArchive(chatTextSpec(), input)
	require.NoError(t, err)
	second, err := youjiTextArchive(chatTextSpec(), input)
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
	for _, name := range []string{"a.json", "a.JSON", "a.JsOn"} {
		copy := input
		copy.Filename = name
		_, err := youjiTextArchive(chatTextSpec(), copy)
		require.NoError(t, err)
	}
	for _, name := range []string{"a.txt", "a.md", "a.html", "a.json.zip", "../a.json", `dir\a.json`, "a\n.json", "", strings.Repeat("a", 241) + ".json"} {
		copy := input
		copy.Filename = name
		_, err := youjiTextArchive(chatTextSpec(), copy)
		require.Error(t, err, name)
	}
	for _, data := range [][]byte{nil, {0xff}, []byte(`{broken}`), []byte(`{} {}`), []byte("\xef\xbb\xbf\xef\xbb\xbf{}"), bytes.Repeat([]byte("x"), (512<<10)+1)} {
		copy := input
		copy.Data = data
		_, err := youjiTextArchive(chatTextSpec(), copy)
		require.Error(t, err)
	}
	for _, content := range []string{"", string([]byte{0xff}), strings.Repeat("x", (256<<10)+1)} {
		copy := input
		copy.Content = content
		_, err := youjiTextArchive(chatTextSpec(), copy)
		require.Error(t, err)
	}
	input.Data = []byte(`"` + strings.Repeat("x", (512<<10)-2) + `"`)
	input.Content = strings.Repeat("x", 256<<10)
	_, err = youjiTextArchive(chatTextSpec(), input)
	require.NoError(t, err)
	_, err = youjiManualArchive(input)
	require.Error(t, err, "manual route must not accept JSON or its larger limit")
}

func TestYoujiChatGatewayAtomicImportAndFixedKind(t *testing.T) {
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
	route := "/api/youji/chat-json/import"
	input := youjiManualRequest{Owner: BuildUserName(user.Username), Filename: "synthetic.json", Content: "# synthetic\n可检索正文", Data: []byte(`{"name":"synthetic","messages":[{"text":"可检索正文<script>doNotRun()</script>"}]}`)}
	body, err := json.Marshal(input)
	require.NoError(t, err)
	require.Equal(t, 401, call(route, body, false).Code)
	rec := call(route, body, true)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	require.Contains(t, rec.Header().Get("Cache-Control"), "no-store")
	var result map[string]string
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &result))
	id, sum := youjiTextIdentity(chatTextSpec(), input.Owner, input.Filename, input.Data)
	require.Equal(t, map[string]string{"memo": "memos/" + id, "attachment": "attachments/ymc-" + strings.TrimPrefix(id, "mwc-"), "sha256": sum, "status": "imported"}, result)
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
	expected, err := youjiTextArchive(chatTextSpec(), input)
	require.NoError(t, err)
	require.Equal(t, expected, attachments[0].Blob)
}

func TestYoujiChatGatewayMaxEscapedBody(t *testing.T) {
	svc, ctx := newUploadTestService(t)
	user, err := svc.fetchCurrentUser(ctx)
	require.NoError(t, err)
	// JSON encoding expands each content byte to six bytes, beyond the manual 2 MiB body limit.
	input := youjiManualRequest{Owner: BuildUserName(user.Username), Filename: "limit.json", Content: strings.Repeat("&", 256<<10), Data: []byte(`"` + strings.Repeat("x", (512<<10)-2) + `"`)}
	body, err := json.Marshal(input)
	require.NoError(t, err)
	require.Greater(t, len(body), 2<<20)
	require.Less(t, len(body), 3<<20)
	response := httptest.NewRecorder()
	svc.importYoujiChat(response, httptest.NewRequest("POST", "/api/youji/chat-json/import", bytes.NewReader(body)).WithContext(ctx), nil)
	require.Equal(t, 422, response.Code, "the built-in 8 KiB quota must still apply")
	require.Contains(t, response.Body.String(), "invalid_content_or_content_quota")
	limit := int64(256 << 10)
	defaultContentLimit := store.DefaultMemoContentBytes
	_, err = svc.Store.UpsertInstanceSetting(ctx, &storepb.InstanceSetting{
		Key:   storepb.InstanceSettingKey_USAGE_LIMITS,
		Value: &storepb.InstanceSetting_UsageLimitsSetting{UsageLimitsSetting: &storepb.InstanceUsageLimitsSetting{Limits: []*storepb.InstanceUsageLimitsSetting_UsageLimit{{UserIds: []int32{user.ID}, MemoContentBytes: &limit}, {AllUsers: true, MemoContentBytes: &defaultContentLimit}}}},
	})
	require.NoError(t, err)
	response = httptest.NewRecorder()
	svc.importYoujiChat(response, httptest.NewRequest("POST", "/api/youji/chat-json/import", bytes.NewReader(body)).WithContext(ctx), nil)
	require.Equal(t, 200, response.Code, response.Body.String())
	oversized := httptest.NewRecorder()
	svc.importYoujiChat(oversized, httptest.NewRequest("POST", "/api/youji/chat-json/import", strings.NewReader(strings.Repeat(" ", 3<<20)+string(body))).WithContext(ctx), nil)
	require.Equal(t, 422, oversized.Code)
	require.Contains(t, oversized.Body.String(), "invalid_input")
}

func TestYoujiChatUnsupportedDriverFailsClosed(t *testing.T) {
	svc, ctx := newUploadTestService(t)
	original := svc.Store
	svc.Store = store.New(youjiNonAtomicDriver{original.GetDriver()}, svc.Profile)
	for _, handler := range []func(http.ResponseWriter, *http.Request, map[string]string){svc.importYoujiChat} {
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
