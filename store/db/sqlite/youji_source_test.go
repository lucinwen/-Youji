package sqlite

import (
	"database/sql"
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/store"
)

func TestYoujiPrivateSourceLifecycleAndFreshReads(t *testing.T) {
	d := manualTestDB(t)
	ctx := t.Context()
	create := func(uid, body string, owner int32) *store.Memo {
		m, _ := manualPair(uid)
		m.CreatorID = owner
		m.Content = body
		result, err := d.CreateMemo(ctx, m)
		require.NoError(t, err)
		return result
	}
	review := create("private-review", "unchanged review", 1)
	first := create("source-one", "# Same title\nFirst secret", 1)
	second := create("source-two", "# Same title\nSecond secret", 1)
	foreign := create("foreign-source", "foreign secret", 2)
	before, err := d.GetYoujiDates(ctx, 1, review.UID)
	require.NoError(t, err)
	none, err := d.GetYoujiSource(ctx, 1, review.UID, false)
	require.NoError(t, err)
	require.Equal(t, "none", none.Status)
	_, err = d.SetYoujiSource(ctx, 1, review.UID, &first.UID)
	require.NoError(t, err)
	meta, err := d.GetYoujiSource(ctx, 1, review.UID, false)
	require.NoError(t, err)
	require.Equal(t, "memos/"+first.UID, meta.SourceName)
	require.Nil(t, meta.Content)
	encoded, err := json.Marshal(meta)
	require.NoError(t, err)
	require.NotContains(t, string(encoded), "secret")
	opened, err := d.GetYoujiSource(ctx, 1, review.UID, true)
	require.NoError(t, err)
	require.Equal(t, first.Content, *opened.Content)
	_, err = d.db.Exec(`UPDATE memo SET content='fresh body' WHERE id=?`, first.ID)
	require.NoError(t, err)
	opened, err = d.GetYoujiSource(ctx, 1, review.UID, true)
	require.NoError(t, err)
	require.Equal(t, "fresh body", *opened.Content)
	_, err = d.SetYoujiSource(ctx, 1, review.UID, &second.UID)
	require.NoError(t, err)
	opened, err = d.GetYoujiSource(ctx, 1, review.UID, true)
	require.NoError(t, err)
	require.Equal(t, second.Content, *opened.Content)
	_, err = d.SetYoujiSource(ctx, 1, review.UID, &foreign.UID)
	require.ErrorIs(t, err, store.ErrYoujiSourceUnavailable)
	_, err = d.SetYoujiSource(ctx, 1, review.UID, &review.UID)
	require.ErrorIs(t, err, store.ErrYoujiSourceUnavailable)
	opened, err = d.GetYoujiSource(ctx, 1, review.UID, true)
	require.NoError(t, err)
	require.Equal(t, second.Content, *opened.Content)
	_, err = d.GetYoujiSource(ctx, 2, review.UID, true)
	require.ErrorIs(t, err, sql.ErrNoRows)
	_, err = d.SetYoujiSource(ctx, 2, review.UID, nil)
	require.ErrorIs(t, err, sql.ErrNoRows)
	for _, visibility := range []string{"PUBLIC", "PROTECTED", "SPACE"} {
		_, err = d.db.Exec(`UPDATE memo SET visibility=? WHERE id=?`, visibility, second.ID)
		require.NoError(t, err)
		hidden, err := d.GetYoujiSource(ctx, 1, review.UID, true)
		require.NoError(t, err)
		require.Equal(t, &store.YoujiSource{Status: "unavailable"}, hidden)
		_, err = d.SetYoujiSource(ctx, 1, review.UID, &second.UID)
		require.ErrorIs(t, err, store.ErrYoujiSourceUnavailable)
	}
	_, err = d.db.Exec(`UPDATE memo SET visibility='PRIVATE',row_status='ARCHIVED' WHERE id=?`, second.ID)
	require.NoError(t, err)
	hidden, err := d.GetYoujiSource(ctx, 1, review.UID, true)
	require.NoError(t, err)
	require.Equal(t, &store.YoujiSource{Status: "unavailable"}, hidden)
	_, err = d.db.Exec(`DELETE FROM memo WHERE id=?`, second.ID)
	require.NoError(t, err)
	replacement := create(second.UID, "replacement must not inherit relation", 1)
	require.NotEqual(t, second.ID, replacement.ID)
	hidden, err = d.GetYoujiSource(ctx, 1, review.UID, true)
	require.NoError(t, err)
	require.Equal(t, &store.YoujiSource{Status: "unavailable"}, hidden)
	_, err = d.SetYoujiSource(ctx, 1, review.UID, nil)
	require.NoError(t, err)
	none, err = d.GetYoujiSource(ctx, 1, review.UID, false)
	require.NoError(t, err)
	require.Equal(t, "none", none.Status)
	_, err = d.db.Exec(`UPDATE memo SET visibility='PUBLIC' WHERE id=?`, review.ID)
	require.NoError(t, err)
	_, err = d.GetYoujiSource(ctx, 1, review.UID, true)
	require.ErrorIs(t, err, sql.ErrNoRows)
	_, err = d.SetYoujiSource(ctx, 1, review.UID, &first.UID)
	require.ErrorIs(t, err, sql.ErrNoRows)
	after, err := d.GetYoujiDates(ctx, 1, review.UID)
	require.NoError(t, err)
	require.Equal(t, before, after)
	var content string
	require.NoError(t, d.db.QueryRow(`SELECT content FROM memo WHERE id=?`, review.ID).Scan(&content))
	require.Equal(t, review.Content, content)
}

func TestYoujiPrivateSourceMigrationDefaultsNone(t *testing.T) {
	d := manualTestDB(t)
	ctx := t.Context()
	m, _ := manualPair("migration-source")
	_, err := d.CreateMemo(ctx, m)
	require.NoError(t, err)
	date := "2024-02-29"
	before, err := d.SetYoujiEventDate(ctx, 1, m.UID, &date)
	require.NoError(t, err)
	_, err = d.db.Exec(`ALTER TABLE memo DROP COLUMN source_memo_id`)
	require.NoError(t, err)
	migration, err := os.ReadFile("../../migration/sqlite/26.11/01__private_source.sql")
	require.NoError(t, err)
	_, err = d.db.Exec(string(migration))
	require.NoError(t, err)
	source, err := d.GetYoujiSource(ctx, 1, m.UID, false)
	require.NoError(t, err)
	require.Equal(t, "none", source.Status)
	after, err := d.GetYoujiDates(ctx, 1, m.UID)
	require.NoError(t, err)
	require.Equal(t, before, after)
}
