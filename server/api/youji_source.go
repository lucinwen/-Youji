package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"

	"github.com/usememos/memos/store"
)

func (s *APIService) registerYoujiSourceRoutes(mux *runtime.ServeMux) error {
	for _, method := range []string{http.MethodGet, http.MethodPatch} {
		if err := mux.HandlePath(method, "/api/youji/memos/{uid}/source", s.youjiSource); err != nil {
			return err
		}
	}
	if err := mux.HandlePath(http.MethodGet, "/api/youji/memos/{uid}/source/open", s.youjiSourceOpen); err != nil {
		return err
	}
	return mux.HandlePath(http.MethodGet, "/api/youji/memos/{uid}/source/candidates", s.youjiSourceCandidates)
}
func (s *APIService) youjiSource(w http.ResponseWriter, r *http.Request, params map[string]string) {
	s.serveYoujiSource(w, r, params, false)
}
func (s *APIService) youjiSourceOpen(w http.ResponseWriter, r *http.Request, params map[string]string) {
	s.serveYoujiSource(w, r, params, true)
}
func (s *APIService) serveYoujiSource(w http.ResponseWriter, r *http.Request, params map[string]string, open bool) {
	w.Header().Set("Cache-Control", "no-store")
	user, err := s.fetchCurrentUser(r.Context())
	if err != nil || user == nil {
		youjiPDFError(w, 401, "authentication_required")
		return
	}
	driver, ok := s.Store.GetDriver().(store.YoujiSourceStore)
	if !ok {
		youjiPDFError(w, 501, "source_store_unavailable")
		return
	}
	var result *store.YoujiSource
	if r.Method == http.MethodPatch {
		var input struct {
			SourceName json.RawMessage `json:"sourceName"`
		}
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		dec.DisallowUnknownFields()
		if dec.Decode(&input) != nil || len(input.SourceName) == 0 || dec.Decode(new(any)) != io.EOF {
			youjiPDFError(w, 400, "invalid_source")
			return
		}
		var sourceName *string
		if json.Unmarshal(input.SourceName, &sourceName) != nil {
			youjiPDFError(w, 400, "invalid_source")
			return
		}
		if _, checkErr := driver.GetYoujiSource(r.Context(), user.ID, params["uid"], false); checkErr != nil {
			if errors.Is(checkErr, sql.ErrNoRows) {
				youjiPDFError(w, 404, "record_unavailable")
			} else {
				youjiPDFError(w, 500, "source_store_failed")
			}
			return
		}
		var sourceUID *string
		if sourceName != nil {
			value, parseErr := ExtractMemoUIDFromName(*sourceName)
			if parseErr != nil || value == "" || len(value) > 256 {
				youjiPDFError(w, 409, "source_unavailable")
				return
			}
			sourceUID = &value
		}
		result, err = driver.SetYoujiSource(r.Context(), user.ID, params["uid"], sourceUID)
	} else {
		result, err = driver.GetYoujiSource(r.Context(), user.ID, params["uid"], open)
	}
	if errors.Is(err, sql.ErrNoRows) {
		youjiPDFError(w, 404, "record_unavailable")
		return
	}
	if errors.Is(err, store.ErrYoujiSourceUnavailable) {
		youjiPDFError(w, 409, "source_unavailable")
		return
	}
	if err != nil {
		youjiPDFError(w, 500, "source_store_failed")
		return
	}
	if open && result.Status == "none" {
		result = &store.YoujiSource{Status: "unavailable"}
	}
	dateResponse(w, result)
}
