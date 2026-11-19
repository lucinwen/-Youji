package store

import (
	"context"
	"database/sql"
	"errors"
)

// YoujiSource is private metadata, never part of normal memo serialization.
// Unavailable references intentionally expose neither the old UID nor content.
type YoujiSource struct {
	Status     string  `json:"status"`
	SourceName string  `json:"sourceName,omitempty"`
	Content    *string `json:"content,omitempty"`
}

// ErrYoujiSourceUnavailable deliberately does not distinguish a missing, foreign,
// nonprivate, archived or self source.
var ErrYoujiSourceUnavailable = errors.New("source unavailable")

// YoujiSourceStore uses authenticated server identity, never client ownership.
type YoujiSourceStore interface {
	GetYoujiSource(context.Context, int32, string, bool) (*YoujiSource, error)
	SetYoujiSource(context.Context, int32, string, *string) (*YoujiSource, error)
}

// ReadYoujiSource authorizes both records in one fresh SQL statement. Metadata
// reads do not select source content, and generic memo caches are never consulted.
func ReadYoujiSource(ctx context.Context, db *sql.DB, dialect string, owner int32, uid string, open bool) (*YoujiSource, error) {
	fields := "review.source_memo_id, source.uid"
	if open {
		fields += ", source.content"
	}
	query := "SELECT " + fields + " FROM memo review LEFT JOIN memo source ON source.id=review.source_memo_id AND source.creator_id=review.creator_id AND source.visibility='PRIVATE' AND source.row_status='NORMAL' WHERE review.uid=? AND review.creator_id=? AND review.visibility='PRIVATE' AND review.row_status='NORMAL'"
	var sourceID sql.NullInt64
	var sourceUID, content sql.NullString
	dest := []any{&sourceID, &sourceUID}
	if open {
		dest = append(dest, &content)
	}
	if err := db.QueryRowContext(ctx, dateSQL(query, dialect), uid, owner).Scan(dest...); err != nil {
		return nil, err
	}
	if !sourceID.Valid {
		return &YoujiSource{Status: "none"}, nil
	}
	if !sourceUID.Valid {
		return &YoujiSource{Status: "unavailable"}, nil
	}
	result := &YoujiSource{Status: "available", SourceName: "memos/" + sourceUID.String}
	if open {
		result.Content = &content.String
	}
	return result, nil
}

// WriteYoujiSource validates both current records inside the mutation statement.
// A source pointer persists by database identity, not its reusable public UID.
func WriteYoujiSource(ctx context.Context, db *sql.DB, dialect string, owner int32, uid string, sourceUID *string) (*YoujiSource, error) {
	var result sql.Result
	var err error
	if sourceUID == nil {
		result, err = db.ExecContext(ctx, dateSQL("UPDATE memo SET source_memo_id=NULL WHERE uid=? AND creator_id=? AND visibility='PRIVATE' AND row_status='NORMAL'", dialect), uid, owner)
	} else {
		if *sourceUID == uid {
			return nil, ErrYoujiSourceUnavailable
		}
		if dialect == "mysql" {
			result, err = db.ExecContext(ctx, "UPDATE memo review JOIN memo source ON source.uid=? AND source.creator_id=review.creator_id AND source.visibility='PRIVATE' AND source.row_status='NORMAL' AND source.id<>review.id SET review.source_memo_id=source.id WHERE review.uid=? AND review.creator_id=? AND review.visibility='PRIVATE' AND review.row_status='NORMAL'", *sourceUID, uid, owner)
		} else {
			query := "UPDATE memo SET source_memo_id=(SELECT id FROM memo source WHERE source.uid=? AND source.creator_id=? AND source.visibility='PRIVATE' AND source.row_status='NORMAL') WHERE uid=? AND creator_id=? AND visibility='PRIVATE' AND row_status='NORMAL' AND EXISTS(SELECT 1 FROM memo source WHERE source.uid=? AND source.creator_id=? AND source.visibility='PRIVATE' AND source.row_status='NORMAL')"
			result, err = db.ExecContext(ctx, dateSQL(query, dialect), *sourceUID, owner, uid, owner, *sourceUID, owner)
		}
	}
	if err != nil {
		return nil, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	current, err := ReadYoujiSource(ctx, db, dialect, owner, uid, false)
	if err != nil {
		return nil, err
	}
	// MySQL reports zero changed rows for an identical assignment. Accept it only
	// when a fresh owner/private read confirms exactly that assignment.
	if affected == 0 && sourceUID != nil && (current.Status != "available" || current.SourceName != "memos/"+*sourceUID) {
		return nil, ErrYoujiSourceUnavailable
	}
	return current, nil
}
