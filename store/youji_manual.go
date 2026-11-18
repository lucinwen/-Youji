package store

import (
	"context"
	"errors"
)

// YoujiManualLimits bounds an atomic manual-text import. Zero means unlimited.
type YoujiManualLimits struct {
	MemoCount    int64
	StorageBytes int64
	UploadBytes  int64
}

// ErrYoujiManualConflict indicates that the original or its record differs.
var ErrYoujiManualConflict = errors.New("manual import conflict")

// ErrYoujiManualQuota indicates that an import exceeds its account limits.
var ErrYoujiManualQuota = errors.New("manual import quota exceeded")

// YoujiManualImporter is an optional driver capability for one private memo and
// its database-backed original. True means an existing matching pair was verified.
// Implementations populate IDs only after success and never overwrite records.
type YoujiManualImporter interface {
	ImportYoujiManual(context.Context, *Memo, *Attachment, YoujiManualLimits) (bool, error)
}
