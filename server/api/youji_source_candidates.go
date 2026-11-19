package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	apipb "github.com/usememos/memos/proto/gen/api"
	"github.com/usememos/memos/store"
)

type youjiSourceCandidate struct {
	Name      string  `json:"name"`
	Label     string  `json:"label"`
	EventDate *string `json:"eventDate"`
	CreatedAt string  `json:"createdAt"`
}
type youjiSourceCandidatesResult struct {
	Candidates    []youjiSourceCandidate `json:"candidates"`
	NextPageToken string                 `json:"nextPageToken"`
}

// sourceCandidateLabel returns only one bounded display line, never a generated summary.
func sourceCandidateLabel(prefix string) string {
	line := ""
	// Manual imports have a known first fenced title field before their raw text.
	if strings.HasPrefix(prefix, "# 有记手动文本\n") {
		const marker = "## 标题、来源与原文件名（用户提供）\n"
		if _, tail, ok := strings.Cut(prefix, marker); ok {
			lines := strings.SplitN(tail, "\n", 3)
			if len(lines) >= 2 && len(lines[0]) >= 3 && strings.Trim(lines[0], "`") == "" {
				line = strings.TrimSpace(lines[1])
			}
		}
	}
	if line == "" {
		for _, candidate := range strings.Split(prefix, "\n") {
			candidate = strings.TrimSpace(candidate)
			if candidate != "" {
				line = strings.TrimLeft(candidate, "# \t")
				break
			}
		}
	}
	line = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, line)
	runes := []rune(line)
	if len(runes) > 80 {
		line = string(runes[:80]) + "…"
	}
	if strings.TrimSpace(line) == "" {
		return "（无标题）"
	}
	return line
}

func (s *APIService) youjiSourceCandidates(w http.ResponseWriter, r *http.Request, params map[string]string) {
	w.Header().Set("Cache-Control", "no-store")
	user, err := s.fetchCurrentUser(r.Context())
	if err != nil || user == nil {
		youjiPDFError(w, 401, "authentication_required")
		return
	}
	sources, ok := s.Store.GetDriver().(store.YoujiSourceStore)
	if !ok {
		youjiPDFError(w, 501, "source_store_unavailable")
		return
	}
	dates, ok := s.Store.GetDriver().(store.YoujiDateStore)
	if !ok {
		youjiPDFError(w, 501, "date_store_unavailable")
		return
	}
	reviewUID := params["uid"]
	if _, err = sources.GetYoujiSource(r.Context(), user.ID, reviewUID, false); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			youjiPDFError(w, 404, "record_unavailable")
		} else {
			youjiPDFError(w, 500, "source_store_failed")
		}
		return
	}
	normal := store.Normal
	review, err := s.Store.GetMemo(r.Context(), &store.FindMemo{UID: &reviewUID, CreatorID: &user.ID, RowStatus: &normal, VisibilityList: []store.Visibility{store.Private}, ExcludeContent: true, ExcludePayload: true})
	if err != nil {
		youjiPDFError(w, 500, "source_store_failed")
		return
	}
	if review == nil {
		youjiPDFError(w, 404, "record_unavailable")
		return
	}
	query := r.URL.Query()
	for key, values := range query {
		if (key != "q" && key != "pageSize" && key != "pageToken") || len(values) != 1 {
			youjiPDFError(w, 400, "invalid_candidate_query")
			return
		}
	}
	q := query.Get("q")
	if !utf8.ValidString(q) || utf8.RuneCountInString(q) > 200 || len(query.Get("pageToken")) > 256 {
		youjiPDFError(w, 400, "invalid_candidate_query")
		return
	}
	limit, offset := 20, 0
	if raw := query.Get("pageSize"); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 20 {
			youjiPDFError(w, 400, "invalid_page_size")
			return
		}
	}
	if raw := query.Get("pageToken"); raw != "" {
		var token apipb.PageToken
		if unmarshalPageToken(raw, &token) != nil || token.Limit < 1 || token.Limit > 20 || token.Offset < 0 || token.Offset > 2147483627 {
			youjiPDFError(w, 400, "invalid_page_token")
			return
		}
		if query.Get("pageSize") != "" && limit != int(token.Limit) {
			youjiPDFError(w, 400, "page_size_changed")
			return
		}
		limit, offset = int(token.Limit), int(token.Offset)
	}
	encoded, _ := json.Marshal(q)
	filter := "content.contains(" + string(encoded) + ")"
	fetchLimit := limit + 1
	find := &store.FindMemo{CreatorID: &user.ID, RowStatus: &normal, VisibilityList: []store.Visibility{store.Private}, ExcludeID: &review.ID, ExcludeComments: true, ExcludePayload: true, ContentPrefixLength: 1024, Filters: []string{filter}, Limit: &fetchLimit, Offset: &offset}
	rows, err := s.Store.ListMemos(r.Context(), find)
	if err != nil {
		youjiPDFError(w, 500, "candidate_search_failed")
		return
	}
	result := youjiSourceCandidatesResult{Candidates: []youjiSourceCandidate{}}
	if len(rows) > limit {
		rows = rows[:limit]
		result.NextPageToken, err = getPageToken(limit, offset+limit)
		if err != nil {
			youjiPDFError(w, 500, "candidate_search_failed")
			return
		}
	}
	// Read calendar metadata, then freshly recheck candidate identity/permissions
	// before projecting labels. Stale list cache/content is never a fallback.
	ids := []int32{}
	metadata := map[int32]*store.YoujiDates{}
	for _, row := range rows {
		date, e := dates.GetYoujiDates(r.Context(), user.ID, row.UID)
		if errors.Is(e, sql.ErrNoRows) {
			continue
		}
		if e != nil {
			youjiPDFError(w, 500, "date_store_failed")
			return
		}
		ids = append(ids, row.ID)
		metadata[row.ID] = date
	}
	if len(ids) > 0 {
		find.IDList = ids
		find.Offset = nil
		find.Limit = nil
		current, e := s.Store.ListMemos(r.Context(), find)
		if e != nil {
			youjiPDFError(w, 500, "candidate_search_failed")
			return
		}
		for _, row := range current {
			result.Candidates = append(result.Candidates, youjiSourceCandidate{Name: buildMemoName(row.UID), Label: sourceCandidateLabel(row.Content), EventDate: metadata[row.ID].EventDate, CreatedAt: time.Unix(row.CreatedTs, 0).UTC().Format(time.RFC3339)})
		}
	}
	// Bind the final review check to its database identity too; a deleted and
	// recreated same-UID record cannot silently become the picker context.
	finalReview, finalErr := s.Store.GetMemo(r.Context(), &store.FindMemo{ID: &review.ID, UID: &reviewUID, CreatorID: &user.ID, RowStatus: &normal, VisibilityList: []store.Visibility{store.Private}, ExcludeContent: true, ExcludePayload: true})
	if finalErr != nil {
		youjiPDFError(w, 500, "source_store_failed")
		return
	}
	if finalReview == nil {
		youjiPDFError(w, 404, "record_unavailable")
		return
	}

	dateResponse(w, result)
}
