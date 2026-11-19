package api

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/server/auth"
	"github.com/usememos/memos/store"
)

func TestYoujiPrivateSourceGateway(t *testing.T) {
	svc, ctx := newUploadTestService(t)
	user, err := svc.fetchCurrentUser(ctx)
	require.NoError(t, err)
	token, _, err := auth.GenerateAccessTokenV2(user.ID, user.Username, string(user.Role), string(user.RowStatus), user.PasswordHash, []byte(svc.Secret))
	require.NoError(t, err)
	handler, err := svc.NewHandler(ctx)
	require.NoError(t, err)
	for _, uid := range []string{"private-review", "private-source"} {
		_, err = svc.Store.CreateMemo(ctx, &store.Memo{UID: uid, CreatorID: user.ID, Content: "synthetic private source body", Visibility: store.Private})
		require.NoError(t, err)
	}
	route := "/api/youji/memos/private-review/source"
	call := func(method, path, body string, signed bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if signed {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	require.Equal(t, 401, call("GET", route, "", false).Code)
	require.Contains(t, call("GET", route, "", true).Body.String(), `"none"`)
	require.Contains(t, call("GET", route+"/open", "", true).Body.String(), `"unavailable"`)
	for _, body := range []string{`{}`, `{"sourceName":5}`, `{"sourceName":null,"owner":"forged"}`, `{"sourceName":null}{}`} {
		require.Equal(t, 400, call("PATCH", route, body, true).Code)
	}
	for _, body := range []string{`{"sourceName":"memos/missing"}`, `{"sourceName":"invalid"}`, `{"sourceName":"memos/private-review"}`} {
		require.Equal(t, 409, call("PATCH", route, body, true).Code)
	}
	rec := call("PATCH", route, `{"sourceName":"memos/private-source"}`, true)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), `"sourceName":"memos/private-source"`)
	require.NotContains(t, rec.Body.String(), "body")
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	rec = call("GET", route+"/open", "", true)
	require.Equal(t, 200, rec.Code)
	require.Contains(t, rec.Body.String(), "synthetic private source body")
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	rec = call("GET", "/api/memos/private-review", "", true)
	require.Equal(t, 200, rec.Code)
	require.NotContains(t, rec.Body.String(), "sourceName")
	require.NotContains(t, rec.Body.String(), "source_memo_id")
	rec = call("PATCH", route, `{"sourceName":null}`, true)
	require.Equal(t, 200, rec.Code)
	require.Contains(t, rec.Body.String(), `"none"`)
	require.Equal(t, 404, call("PATCH", "/api/youji/memos/missing/source", `{"sourceName":"memos/private-source"}`, true).Code)
}
