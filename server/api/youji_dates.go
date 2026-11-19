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

func (s *APIService) registerYoujiDateRoutes(mux *runtime.ServeMux) error {
	for _, method := range []string{http.MethodGet, http.MethodPatch} {
		if err := mux.HandlePath(method, "/api/youji/memos/{uid}/dates", s.youjiMemoDates); err != nil {
			return err
		}
	}
	return nil
}
func dateResponse(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(value)
}
func (s *APIService) youjiMemoDates(w http.ResponseWriter, r *http.Request, params map[string]string) {
	w.Header().Set("Cache-Control", "no-store")
	user, err := s.fetchCurrentUser(r.Context())
	if err != nil || user == nil {
		youjiPDFError(w, 401, "authentication_required")
		return
	}
	driver, ok := s.Store.GetDriver().(store.YoujiDateStore)
	if !ok {
		youjiPDFError(w, 501, "date_store_unavailable")
		return
	}
	var result *store.YoujiDates
	if r.Method == http.MethodPatch {
		var input struct {
			EventDate json.RawMessage `json:"eventDate"`
		}
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		dec.DisallowUnknownFields()
		if dec.Decode(&input) != nil || len(input.EventDate) == 0 || dec.Decode(new(any)) != io.EOF {
			youjiPDFError(w, 400, "invalid_event_date")
			return
		}
		var date *string
		if json.Unmarshal(input.EventDate, &date) != nil {
			youjiPDFError(w, 400, "invalid_event_date")
			return
		}
		if date != nil && *date == "" {
			date = nil
		}
		if date != nil && !store.ValidYoujiEventDate(*date) {
			youjiPDFError(w, 400, "invalid_event_date")
			return
		}
		result, err = driver.SetYoujiEventDate(r.Context(), user.ID, params["uid"], date)
	} else {
		result, err = driver.GetYoujiDates(r.Context(), user.ID, params["uid"])
	}
	if errors.Is(err, sql.ErrNoRows) {
		youjiPDFError(w, 404, "record_unavailable")
		return
	}
	if err != nil {
		youjiPDFError(w, 500, "date_store_failed")
		return
	}
	dateResponse(w, result)
}
