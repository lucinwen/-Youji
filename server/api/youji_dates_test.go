package api

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/server/auth"
	"github.com/usememos/memos/store"
)

func TestYoujiDatesGatewayStrictMutation(t *testing.T) {
	svc, ctx := newUploadTestService(t)
	user, err := svc.fetchCurrentUser(ctx)
	require.NoError(t, err)
	token, _, err := auth.GenerateAccessTokenV2(user.ID, user.Username, string(user.Role), string(user.RowStatus), user.PasswordHash, []byte(svc.Secret))
	require.NoError(t, err)
	handler, err := svc.NewHandler(ctx)
	require.NoError(t, err)
	m, err := svc.Store.CreateMemo(ctx, &store.Memo{UID: "career-date-test", CreatorID: user.ID, Content: "synthetic immutable body", Visibility: store.Private})
	require.NoError(t, err)
	route := "/api/youji/memos/" + m.UID + "/dates"
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
	rec := call("GET", route, "", true)
	require.Equal(t, 200, rec.Code)
	var initial store.YoujiDates
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &initial))
	require.Equal(t, "captured", initial.CaptureTimeBasis)
	for _, body := range []string{`{}`, `{"eventDate":"2026-02-29"}`, `{"eventDate":5}`, `{"eventDate":"0000-01-01"}`, `{"eventDate":"2024-02-29","capturedAt":"forged"}`, `{"eventDate":"2024-02-29"}{}`} {
		rec = call("PATCH", route, body, true)
		require.Equal(t, 400, rec.Code, body)
	}
	rec = call("GET", route, "", true)
	require.Contains(t, rec.Body.String(), `"eventDate":null`)
	rec = call("PATCH", route, `{"eventDate":"2024-02-29"}`, true)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var changed store.YoujiDates
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &changed))
	require.Equal(t, initial.CapturedAt, changed.CapturedAt)
	require.Equal(t, "2024-02-29", *changed.EventDate)
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	rec = call("PATCH", route, `{"eventDate":null}`, true)
	require.Equal(t, 200, rec.Code)
	require.Contains(t, rec.Body.String(), `"eventDate":null`)
	require.Equal(t, 404, call("PATCH", "/api/youji/memos/absent/dates", `{"eventDate":null}`, true).Code)
	for _, filter := range []string{`event_date == "2024-02-29"`, `creator == "users/other" && event_date != ""`, `creator == "` + user.Username + `" || event_date != ""`} {
		require.Error(t, svc.validateMemoFilterForUser(ctx, filter, user))
	}
	require.NoError(t, svc.validateMemoFilterForUser(ctx, `creator == "`+BuildUserName(user.Username)+`" && event_date >= "2024-02-29"`, user))
}
