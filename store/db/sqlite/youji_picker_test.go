package sqlite

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/store"
)

func TestYoujiPickerBoundedContentAndSelfBeforePagination(t *testing.T) {
	d := manualTestDB(t)
	ctx := t.Context()
	first, _ := manualPair("prefix-first")
	first.Content = strings.Repeat("中", 5000)
	_, err := d.CreateMemo(ctx, first)
	require.NoError(t, err)
	review, _ := manualPair("prefix-review")
	_, err = d.CreateMemo(ctx, review)
	require.NoError(t, err)
	owner := int32(1)
	limit := 1
	rows, err := d.ListMemos(ctx, &store.FindMemo{CreatorID: &owner, ExcludeID: &review.ID, ContentPrefixLength: 1024, ExcludePayload: true, Limit: &limit})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, first.ID, rows[0].ID)
	require.Equal(t, 1024, utf8.RuneCountInString(rows[0].Content))
	rows, err = d.ListMemos(ctx, &store.FindMemo{ID: &first.ID})
	require.NoError(t, err)
	require.Equal(t, first.Content, rows[0].Content)
	rows, err = d.ListMemos(ctx, &store.FindMemo{ID: &first.ID, ContentPrefixLength: 1024, ExcludeContent: true})
	require.NoError(t, err)
	require.Empty(t, rows[0].Content)
}
