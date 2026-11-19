package postgres

import (
	"context"

	"github.com/usememos/memos/store"
)

func (d *DB) GetYoujiSource(ctx context.Context, owner int32, uid string, open bool) (*store.YoujiSource, error) {
	return store.ReadYoujiSource(ctx, d.db, "postgres", owner, uid, open)
}
func (d *DB) SetYoujiSource(ctx context.Context, owner int32, uid string, source *string) (*store.YoujiSource, error) {
	return store.WriteYoujiSource(ctx, d.db, "postgres", owner, uid, source)
}
