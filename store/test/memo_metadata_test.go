package test

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

// This shared regression runs against whichever database DRIVER selects.
func TestMemoExcludePayloadPreservesFiltering(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	ts := NewTestingStore(ctx, t)
	t.Cleanup(func() { require.NoError(t, ts.Close()) })
	user, err := createTestingHostUser(ctx, ts)
	require.NoError(t, err)
	payload := &storepb.MemoPayload{Tags: []string{"metadata-match", strings.Repeat("synthetic-payload-", 65536)}}
	memo, err := ts.CreateMemo(ctx, &store.Memo{UID: "metadata-large-payload", CreatorID: user.ID, Content: "original body", Visibility: store.Private, Payload: payload})
	require.NoError(t, err)
	find := &store.FindMemo{CreatorID: &user.ID, Filters: []string{`tag in ["metadata-match"]`}, ExcludeContent: true, ExcludePayload: true}
	rows, err := ts.ListMemos(ctx, find)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, memo.ID, rows[0].ID)
	require.Empty(t, rows[0].Content)
	require.NotNil(t, rows[0].Payload)
	require.True(t, proto.Equal(&storepb.MemoPayload{}, rows[0].Payload))
	find.ExcludeContent = false
	rows, err = ts.ListMemos(ctx, find)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, "original body", rows[0].Content)
	require.True(t, proto.Equal(&storepb.MemoPayload{}, rows[0].Payload))
	find.Filters = []string{`tag in ["not-present"]`}
	rows, err = ts.ListMemos(ctx, find)
	require.NoError(t, err)
	require.Empty(t, rows)
	// Exclusion is a projection only: normal reads retain the full stored payload.
	stored, err := ts.GetMemo(ctx, &store.FindMemo{ID: &memo.ID})
	require.NoError(t, err)
	require.NotNil(t, stored)
	require.True(t, proto.Equal(payload, stored.Payload))
}
