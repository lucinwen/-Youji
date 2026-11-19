package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// YoujiDates separates a calendar event day from the immutable new-record capture time.
// Legacy-created is explicitly an editable historical record time, not an audit timestamp.
type YoujiDates struct {
	EventDate        *string `json:"eventDate"`
	CapturedAt       string  `json:"capturedAt"`
	CaptureTimeBasis string  `json:"captureTimeBasis"`
}

// YoujiDateStore is implemented by all SQL drivers; identity is always supplied by the authenticated server.
type YoujiDateStore interface {
	GetYoujiDates(context.Context, int32, string) (*YoujiDates, error)
	SetYoujiEventDate(context.Context, int32, string, *string) (*YoujiDates, error)
}

// ValidYoujiEventDate checks the exact calendar representation without timezone conversion.
func ValidYoujiEventDate(value string) bool {
	if len(value) != 10 || value[:4] == "0000" {
		return false
	}
	t, err := time.Parse("2006-01-02", value)
	return err == nil && t.Format("2006-01-02") == value
}
func dateSQL(query, dialect string) string {
	if dialect != "postgres" {
		return query
	}
	for i := 1; strings.Contains(query, "?"); i++ {
		query = strings.Replace(query, "?", fmt.Sprintf("$%d", i), 1)
	}
	return query
}

// ReadYoujiDates performs ownership filtering in SQL, including for public memos.
func ReadYoujiDates(ctx context.Context, db *sql.DB, dialect string, owner int32, uid string) (*YoujiDates, error) {
	created := "created_ts"
	if dialect == "mysql" {
		created = "UNIX_TIMESTAMP(created_ts)"
	}
	var event sql.NullString
	var captured sql.NullInt64
	var legacy int64
	err := db.QueryRowContext(ctx, dateSQL("SELECT event_date,captured_ts,"+created+" FROM memo WHERE uid=? AND creator_id=? AND row_status='NORMAL'", dialect), uid, owner).Scan(&event, &captured, &legacy)
	if err != nil {
		return nil, err
	}
	result := &YoujiDates{CaptureTimeBasis: "legacy-created", CapturedAt: time.Unix(legacy, 0).UTC().Format(time.RFC3339)}
	if event.Valid {
		result.EventDate = &event.String
	}
	if captured.Valid {
		result.CaptureTimeBasis = "captured"
		result.CapturedAt = time.Unix(captured.Int64, 0).UTC().Format(time.RFC3339)
	}
	return result, nil
}

// WriteYoujiEventDate changes only date metadata. It cannot rewrite original text or capture time.
func WriteYoujiEventDate(ctx context.Context, db *sql.DB, dialect string, owner int32, uid string, date *string) (*YoujiDates, error) {
	if date != nil && !ValidYoujiEventDate(*date) {
		return nil, errors.New("invalid event date")
	}
	_, err := db.ExecContext(ctx, dateSQL("UPDATE memo SET event_date=? WHERE uid=? AND creator_id=? AND row_status='NORMAL'", dialect), date, uid, owner)
	if err != nil {
		return nil, err
	}
	return ReadYoujiDates(ctx, db, dialect, owner, uid)
}
