package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/server/auth"
	"github.com/usememos/memos/store"
)

func TestYoujiSourceCandidateLabelBounded(t *testing.T) {
	require.Equal(t, "合成岗位标题", sourceCandidateLabel("# 有记手动文本\n\n#拾微 #work\n\n## 标题、来源与原文件名（用户提供）\n```\n合成岗位标题\n工作思考\nfile.txt\n```\nsecret transcript"))
	require.Equal(t, "same title", sourceCandidateLabel("\n# same title\nNEVER RETURN BODY"))
	require.LessOrEqual(t, utf8.RuneCountInString(sourceCandidateLabel(strings.Repeat("中", 5000))), 81)
	require.Equal(t, "（无标题）", sourceCandidateLabel(" \n\t"))
	require.Equal(t, "<script>literal</script>", sourceCandidateLabel("<script>literal</script>\nnever render HTML"))
}

func TestYoujiSourceCandidatesGatewayPaginationAndPrivacy(t *testing.T) {
	svc, ctx := newUploadTestService(t)
	user, err := svc.fetchCurrentUser(ctx)
	require.NoError(t, err)
	token, _, err := auth.GenerateAccessTokenV2(user.ID, user.Username, string(user.Role), string(user.RowStatus), user.PasswordHash, []byte(svc.Secret))
	require.NoError(t, err)
	handler, err := svc.NewHandler(ctx)
	require.NoError(t, err)
	create := func(uid string, visibility store.Visibility) *store.Memo {
		m, e := svc.Store.CreateMemo(ctx, &store.Memo{UID: uid, CreatorID: user.ID, Content: "# same title\nSyntheticPickerNeedle NEVER_RETURN_FULL_BODY", Visibility: visibility})
		require.NoError(t, e)
		return m
	}
	for i := range 25 {
		create(fmt.Sprintf("picker-%02d", i), store.Private)
	}
	review := create("picker-review", store.Private)
	create("picker-public", store.Public)
	archived := create("picker-archived", store.Private)
	require.NoError(t, svc.Store.GetDriver().GetDB().QueryRow(`UPDATE memo SET row_status='ARCHIVED' WHERE id=? RETURNING id`, archived.ID).Scan(&archived.ID))
	other, err := svc.Store.CreateUser(ctx, &store.User{Username: "picker-other", Role: store.RoleUser, PasswordHash: "unused"})
	require.NoError(t, err)
	_, err = svc.Store.CreateMemo(ctx, &store.Memo{UID: "picker-foreign", CreatorID: other.ID, Content: "# same title\nSyntheticPickerNeedle", Visibility: store.Private})
	require.NoError(t, err)
	route := "/api/youji/memos/" + review.UID + "/source/candidates"
	call := func(path string, signed bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		if signed {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	require.Equal(t, 401, call(route, false).Code)
	for _, query := range []string{"pageSize=21", "pageSize=0", "pageToken=bad", "filter=true", "creator=other", "q=a&q=b", "q=" + strings.Repeat("x", 201)} {
		require.Equal(t, 400, call(route+"?"+query, true).Code, query)
	}
	next := ""
	seen := map[string]bool{}
	pages := 0
	for {
		query := url.Values{"q": {"SyntheticPickerNeedle"}, "pageSize": {"10"}}
		if next != "" {
			query.Set("pageToken", next)
		}
		rec := call(route+"?"+query.Encode(), true)
		require.Equal(t, 200, rec.Code, rec.Body.String())
		require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
		require.NotContains(t, rec.Body.String(), "NEVER_RETURN_FULL_BODY")
		var page youjiSourceCandidatesResult
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &page))
		pages++
		for _, candidate := range page.Candidates {
			require.False(t, seen[candidate.Name])
			seen[candidate.Name] = true
			require.Equal(t, "same title", candidate.Label)
			require.NotEmpty(t, candidate.CreatedAt)
			require.Nil(t, candidate.EventDate)
			require.NotEqual(t, "memos/"+review.UID, candidate.Name)
		}
		var object map[string]json.RawMessage
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &object))
		require.Len(t, object, 2)
		var fields []map[string]json.RawMessage
		require.NoError(t, json.Unmarshal(object["candidates"], &fields))
		for _, field := range fields {
			require.Len(t, field, 4)
		}
		next = page.NextPageToken
		if next == "" {
			break
		}
		require.Less(t, pages, 5)
	}
	require.Equal(t, 3, pages)
	require.Len(t, seen, 25)
	require.False(t, seen["memos/picker-public"])
	require.False(t, seen["memos/picker-archived"])
	injection := `x") || true || ("`
	rec := call(route+"?"+url.Values{"q": {injection}}.Encode(), true)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var empty youjiSourceCandidatesResult
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &empty))
	require.Empty(t, empty.Candidates)
	create("picker-literal", store.Private)
	_, err = svc.Store.GetDriver().GetDB().Exec(`UPDATE memo SET content=? WHERE uid='picker-literal'`, "Literal\n"+injection)
	require.NoError(t, err)
	rec = call(route+"?"+url.Values{"q": {injection}}.Encode(), true)
	require.Equal(t, 200, rec.Code)
	var literal youjiSourceCandidatesResult
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &literal))
	require.Len(t, literal.Candidates, 1)
	require.Equal(t, "memos/picker-literal", literal.Candidates[0].Name)
	_, err = svc.Store.GetDriver().GetDB().Exec(`UPDATE memo SET visibility='PUBLIC' WHERE id=?`, review.ID)
	require.NoError(t, err)
	require.Equal(t, 404, call(route, true).Code)
}

// A deterministic interleave over real SQLite verifies the post-list check;
// it is not a claim about the frequency of natural network races.
type sourcePickerInterleave struct {
	store.Driver
	afterList func()
}

func (d *sourcePickerInterleave) ListMemos(ctx context.Context, find *store.FindMemo) ([]*store.Memo, error) {
	rows, err := d.Driver.ListMemos(ctx, find)
	if err == nil && find.ContentPrefixLength > 0 && len(find.IDList) == 0 && d.afterList != nil {
		hook := d.afterList
		d.afterList = nil
		hook()
	}
	return rows, err
}
func (d *sourcePickerInterleave) GetYoujiSource(ctx context.Context, owner int32, uid string, open bool) (*store.YoujiSource, error) {
	return d.Driver.(store.YoujiSourceStore).GetYoujiSource(ctx, owner, uid, open)
}
func (d *sourcePickerInterleave) SetYoujiSource(ctx context.Context, owner int32, uid string, source *string) (*store.YoujiSource, error) {
	return d.Driver.(store.YoujiSourceStore).SetYoujiSource(ctx, owner, uid, source)
}
func (d *sourcePickerInterleave) GetYoujiDates(ctx context.Context, owner int32, uid string) (*store.YoujiDates, error) {
	return d.Driver.(store.YoujiDateStore).GetYoujiDates(ctx, owner, uid)
}
func (d *sourcePickerInterleave) SetYoujiEventDate(ctx context.Context, owner int32, uid string, date *string) (*store.YoujiDates, error) {
	return d.Driver.(store.YoujiDateStore).SetYoujiEventDate(ctx, owner, uid, date)
}
func TestYoujiSourceCandidatesFreshPermissionAndReviewIdentity(t *testing.T) {
	for _, replacement := range []bool{false, true} {
		t.Run(fmt.Sprint(replacement), func(t *testing.T) {
			svc, ctx := newUploadTestService(t)
			user, err := svc.fetchCurrentUser(ctx)
			require.NoError(t, err)
			review, err := svc.Store.CreateMemo(ctx, &store.Memo{UID: "interleaved-review", CreatorID: user.ID, Content: "review", Visibility: store.Private})
			require.NoError(t, err)
			source, err := svc.Store.CreateMemo(ctx, &store.Memo{UID: "interleaved-source", CreatorID: user.ID, Content: "candidate secret", Visibility: store.Private})
			require.NoError(t, err)
			original := svc.Store.GetDriver()
			wrapped := &sourcePickerInterleave{Driver: original, afterList: func() {
				if replacement {
					_, err := original.GetDB().Exec(`DELETE FROM memo WHERE id=?`, review.ID)
					require.NoError(t, err)
					newReview, err := original.CreateMemo(ctx, &store.Memo{UID: review.UID, CreatorID: user.ID, Content: "replacement review", Visibility: store.Private})
					require.NoError(t, err)
					require.NotEqual(t, review.ID, newReview.ID)
				} else {
					_, err := original.GetDB().Exec(`UPDATE memo SET visibility='PUBLIC' WHERE id=?`, source.ID)
					require.NoError(t, err)
				}
			}}
			svc.Store = store.New(wrapped, svc.Profile)
			token, _, err := auth.GenerateAccessTokenV2(user.ID, user.Username, string(user.Role), string(user.RowStatus), user.PasswordHash, []byte(svc.Secret))
			require.NoError(t, err)
			handler, err := svc.NewHandler(ctx)
			require.NoError(t, err)
			r := httptest.NewRequest("GET", "/api/youji/memos/"+review.UID+"/source/candidates", nil)
			r.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, r)
			if replacement {
				require.Equal(t, 404, rec.Code)
			} else {
				require.Equal(t, 200, rec.Code, rec.Body.String())
				var result youjiSourceCandidatesResult
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &result))
				require.Empty(t, result.Candidates)
			}
			require.NotContains(t, rec.Body.String(), "candidate secret")
			require.NotContains(t, rec.Body.String(), "replacement review")
		})
	}
}
