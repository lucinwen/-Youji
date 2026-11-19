package postgres

import (
	"context"

	"github.com/usememos/memos/store"
)

func (d *DB) GetYoujiDates(ctx context.Context, owner int32, uid string) (*store.YoujiDates, error) {
	return store.ReadYoujiDates(ctx, d.db, "postgres", owner, uid)
}
func (d *DB) SetYoujiEventDate(ctx context.Context, owner int32, uid string, date *string) (*store.YoujiDates, error) {
	return store.WriteYoujiEventDate(ctx, d.db, "postgres", owner, uid, date)
}
