package sqlite

import (
	"database/sql"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/store"
)

func TestYoujiDatesCaptureEventAndOwner(t *testing.T) {
	d := manualTestDB(t)
	ctx := t.Context()
	m, a := manualPair("dates-source")
	_, err := d.ImportYoujiManual(ctx, m, a, store.YoujiManualLimits{})
	require.NoError(t, err)
	before, err := d.GetYoujiDates(ctx, 1, m.UID)
	require.NoError(t, err)
	require.Nil(t, before.EventDate)
	require.Equal(t, "captured", before.CaptureTimeBasis)
	date := "2024-02-29"
	after, err := d.SetYoujiEventDate(ctx, 1, m.UID, &date)
	require.NoError(t, err)
	require.Equal(t, date, *after.EventDate)
	require.Equal(t, before.CapturedAt, after.CapturedAt)
	_, err = d.db.Exec(`UPDATE memo SET created_ts=1,updated_ts=2,content='changed body' WHERE id=?`, m.ID)
	require.NoError(t, err)
	after, err = d.GetYoujiDates(ctx, 1, m.UID)
	require.NoError(t, err)
	require.Equal(t, before.CapturedAt, after.CapturedAt)
	_, err = d.SetYoujiEventDate(ctx, 2, m.UID, nil)
	require.ErrorIs(t, err, sql.ErrNoRows)
	_, err = d.GetYoujiDates(ctx, 2, m.UID)
	require.ErrorIs(t, err, sql.ErrNoRows)
	for _, bad := range []string{"2023-02-29", "2024-2-29", "0000-01-01", "2026-11-19T00:00:00Z", "2026-04-31"} {
		_, err = d.SetYoujiEventDate(ctx, 1, m.UID, &bad)
		require.Error(t, err)
	}
	after, err = d.GetYoujiDates(ctx, 1, m.UID)
	require.NoError(t, err)
	require.Equal(t, date, *after.EventDate)
	cleared, err := d.SetYoujiEventDate(ctx, 1, m.UID, nil)
	require.NoError(t, err)
	require.Nil(t, cleared.EventDate)
	require.Equal(t, before.CapturedAt, cleared.CapturedAt)
	var content string
	require.NoError(t, d.db.QueryRow(`SELECT content FROM memo WHERE id=?`, m.ID).Scan(&content))
	require.Equal(t, "changed body", content)
	var original []byte
	require.NoError(t, d.db.QueryRow(`SELECT blob FROM attachment WHERE id=?`, a.ID).Scan(&original))
	require.Equal(t, a.Blob, original)
}

func TestYoujiDateMigrationLegacyAndNativePagination(t *testing.T) {
	d := manualTestDB(t)
	ctx := t.Context()
	_, err := d.db.Exec(`INSERT INTO memo(uid,creator_id,content,created_ts) VALUES('legacy-date',1,'unchanged',100),('foreign-date',2,'private',100)`)
	require.NoError(t, err)
	old, err := d.GetYoujiDates(ctx, 1, "legacy-date")
	require.NoError(t, err)
	require.Equal(t, "legacy-created", old.CaptureTimeBasis)
	require.Equal(t, "1970-01-01T00:01:40Z", old.CapturedAt)
	day := "2026-11-19"
	_, err = d.SetYoujiEventDate(ctx, 1, "legacy-date", &day)
	require.NoError(t, err)
	for _, uid := range []string{"dated-a", "dated-b", "unknown-date"} {
		m, _ := manualPair(uid)
		_, err = d.CreateMemo(ctx, m)
		require.NoError(t, err)
		if uid != "unknown-date" {
			_, err = d.SetYoujiEventDate(ctx, 1, uid, &day)
			require.NoError(t, err)
		}
	}
	owner := int32(1)
	limit := 1
	offset := 0
	var ids []string
	for {
		rows, err := d.ListMemos(ctx, &store.FindMemo{CreatorID: &owner, Filters: []string{`event_date >= "2026-11-19" && event_date <= "2026-11-19"`}, Limit: &limit, Offset: &offset})
		require.NoError(t, err)
		if len(rows) == 0 {
			break
		}
		ids = append(ids, rows[0].UID)
		offset++
	}
	require.ElementsMatch(t, []string{"legacy-date", "dated-a", "dated-b"}, ids)
	rows, err := d.ListMemos(ctx, &store.FindMemo{CreatorID: &owner, Filters: []string{`event_date == ""`}})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, "unknown-date", rows[0].UID)
	all, err := d.ListMemos(ctx, &store.FindMemo{CreatorID: &owner})
	require.NoError(t, err)
	require.Len(t, all, 4)
	// Exercise the exact incremental SQL on an old table rather than inferring migration behavior from fresh schema.
	_, err = d.db.Exec(`CREATE TABLE old_dates_backup AS SELECT uid,content,created_ts FROM memo`)
	require.NoError(t, err)
	_, err = d.db.Exec(`DROP INDEX idx_memo_event_date; ALTER TABLE memo DROP COLUMN event_date; ALTER TABLE memo DROP COLUMN captured_ts`)
	require.NoError(t, err)
	migration, err := os.ReadFile("../../migration/sqlite/26.11/00__career_dates.sql")
	require.NoError(t, err)
	_, err = d.db.Exec(string(migration))
	require.NoError(t, err)
	migrated, err := d.GetYoujiDates(ctx, 1, "legacy-date")
	require.NoError(t, err)
	require.Nil(t, migrated.EventDate)
	require.Equal(t, "legacy-created", migrated.CaptureTimeBasis)
	var different int
	require.NoError(t, d.db.QueryRow(`SELECT count(*) FROM memo m JOIN old_dates_backup b ON b.uid=m.uid WHERE b.content!=m.content OR b.created_ts!=m.created_ts`).Scan(&different))
	require.Zero(t, different)
	for _, driver := range []string{"sqlite", "mysql", "postgres"} {
		sql, err := os.ReadFile("../../migration/" + driver + "/26.11/00__career_dates.sql")
		require.NoError(t, err)
		require.Contains(t, string(sql), "event_date")
		require.Contains(t, string(sql), "captured_ts")
		require.NotContains(t, strings.ToUpper(string(sql)), "UPDATE MEMO")
	}
}
