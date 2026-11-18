package sqlite

import (
	"context"
	"database/sql"
	"errors"

	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

var _ store.YoujiManualImporter = (*DB)(nil)

// ImportYoujiManual atomically inserts or verifies a private memo and ZIP original.
func (d *DB) ImportYoujiManual(ctx context.Context, memo *store.Memo, attachment *store.Attachment, limits store.YoujiManualLimits) (bool, error) {
	if memo == nil || attachment == nil || memo.UID == "" || attachment.UID == "" ||
		memo.CreatorID <= 0 || attachment.CreatorID != memo.CreatorID || memo.Visibility != store.Private ||
		memo.SpaceID != nil || memo.Pinned || (memo.RowStatus != "" && memo.RowStatus != store.Normal) ||
		attachment.StorageType != storepb.AttachmentStorageType_ATTACHMENT_STORAGE_TYPE_UNSPECIFIED ||
		attachment.Reference != "" || attachment.Type != "application/zip" || attachment.Filename == "" ||
		attachment.Size <= 0 || attachment.Size != int64(len(attachment.Blob)) {
		return false, store.ErrYoujiManualConflict
	}
	if limits.MemoCount < 0 || limits.StorageBytes < 0 || limits.UploadBytes < 0 {
		return false, store.ErrYoujiManualQuota
	}
	m, a := *memo, *attachment
	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := requireSQLiteActiveMemoActor(ctx, tx, m.CreatorID); err != nil {
		return false, err
	}
	var existing store.Memo
	var space sql.NullInt64
	err = tx.QueryRowContext(ctx, `SELECT id, creator_id, visibility, row_status, content, space_id, created_ts, updated_ts FROM memo WHERE uid = ?`, m.UID).
		Scan(&existing.ID, &existing.CreatorID, &existing.Visibility, &existing.RowStatus, &existing.Content, &space, &existing.CreatedTs, &existing.UpdatedTs)
	if err == nil {
		if existing.CreatorID != m.CreatorID || existing.Visibility != store.Private || existing.RowStatus != store.Normal || space.Valid || existing.Content != m.Content {
			return false, store.ErrYoujiManualConflict
		}
		var count int64
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM attachment WHERE memo_id = ?`, existing.ID).Scan(&count); err != nil {
			return false, err
		}
		if count != 1 {
			return false, store.ErrYoujiManualConflict
		}
		err = tx.QueryRowContext(ctx, `SELECT id, created_ts, updated_ts FROM attachment
			WHERE memo_id = ? AND uid = ? AND creator_id = ? AND filename = ? AND type = ? AND size = ?
			AND blob = ? AND storage_type = '' AND reference = ''`, existing.ID, a.UID, a.CreatorID, a.Filename, a.Type, a.Size, a.Blob).
			Scan(&a.ID, &a.CreatedTs, &a.UpdatedTs)
		if errors.Is(err, sql.ErrNoRows) {
			return false, store.ErrYoujiManualConflict
		}
		if err != nil {
			return false, err
		}
		m.ID, m.CreatedTs, m.UpdatedTs, m.RowStatus = existing.ID, existing.CreatedTs, existing.UpdatedTs, existing.RowStatus
		a.MemoID = &m.ID
		if err := tx.Commit(); err != nil {
			return false, err
		}
		*memo, *attachment = m, a
		return true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	var occupied bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM attachment WHERE uid = ?)`, a.UID).Scan(&occupied); err != nil {
		return false, err
	}
	if occupied {
		return false, store.ErrYoujiManualConflict
	}
	var count, storageBytes int64
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM memo WHERE creator_id = ?`, m.CreatorID).Scan(&count); err != nil {
		return false, err
	}
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(SUM(size), 0) FROM attachment WHERE creator_id = ?`, m.CreatorID).Scan(&storageBytes); err != nil {
		return false, err
	}
	if (limits.MemoCount > 0 && count >= limits.MemoCount) ||
		(limits.UploadBytes > 0 && a.Size > limits.UploadBytes) ||
		(limits.StorageBytes > 0 && (a.Size > limits.StorageBytes || storageBytes > limits.StorageBytes-a.Size)) {
		return false, store.ErrYoujiManualQuota
	}
	if err := validateSQLiteMemoCreate(ctx, tx, &m); err != nil {
		return false, err
	}
	if err := insertSQLiteMemo(ctx, tx, &m); err != nil {
		return false, err
	}
	a.MemoID = &m.ID
	if _, err := insertSQLiteAttachment(ctx, tx, &a); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	*memo, *attachment = m, a
	return false, nil
}
