package sqlite

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/internal/profile"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

func manualTestDB(t *testing.T) *DB {
	t.Helper()
	driver, err := NewDB(&profile.Profile{DSN: filepath.Join(t.TempDir(), "manual.db")})
	require.NoError(t, err)
	d := driver.(*DB)
	t.Cleanup(func() { require.NoError(t, d.Close()) })
	schema, err := os.ReadFile("../../migration/sqlite/LATEST.sql")
	require.NoError(t, err)
	_, err = d.db.Exec(string(schema))
	require.NoError(t, err)
	_, err = d.db.Exec(`INSERT INTO user(id,username,password_hash) VALUES(1,'synthetic','unused'),(2,'other','unused')`)
	require.NoError(t, err)
	return d
}

func manualPair(uid string) (*store.Memo, *store.Attachment) {
	return &store.Memo{UID: uid, CreatorID: 1, Visibility: store.Private, Content: "synthetic manual body", Payload: &storepb.MemoPayload{Tags: []string{"source/text"}}},
		&store.Attachment{UID: "original-" + uid, CreatorID: 1, Filename: uid + ".zip", Type: "application/zip", Size: 3, Blob: []byte("zip")}
}

func manualCounts(t *testing.T, d *DB, memos, attachments int) {
	t.Helper()
	var m, a int
	require.NoError(t, d.db.QueryRow(`SELECT COUNT(*) FROM memo`).Scan(&m))
	require.NoError(t, d.db.QueryRow(`SELECT COUNT(*) FROM attachment`).Scan(&a))
	require.Equal(t, memos, m)
	require.Equal(t, attachments, a)
}

func TestYoujiManualCreateVerifyAndOwner(t *testing.T) {
	d := manualTestDB(t)
	m, a := manualPair("first")
	verified, err := d.ImportYoujiManual(t.Context(), m, a, store.YoujiManualLimits{})
	require.NoError(t, err)
	require.False(t, verified)
	require.Positive(t, m.ID)
	require.Equal(t, m.ID, *a.MemoID)
	freshM, freshA := manualPair("first")
	// Verification consumes no quota, even when current limits are below usage.
	verified, err = d.ImportYoujiManual(t.Context(), freshM, freshA, store.YoujiManualLimits{MemoCount: 1, StorageBytes: 1, UploadBytes: 1})
	require.NoError(t, err)
	require.True(t, verified)
	require.Equal(t, m.ID, freshM.ID)
	require.Equal(t, a.ID, freshA.ID)
	require.Equal(t, a.UpdatedTs, freshA.UpdatedTs)
	freshM.CreatorID, freshA.CreatorID = 2, 2
	_, err = d.ImportYoujiManual(t.Context(), freshM, freshA, store.YoujiManualLimits{})
	require.ErrorIs(t, err, store.ErrYoujiManualConflict)
	_, err = d.db.Exec(`UPDATE user SET row_status='ARCHIVED' WHERE id=1`)
	require.NoError(t, err)
	_, err = d.ImportYoujiManual(t.Context(), m, a, store.YoujiManualLimits{})
	require.ErrorIs(t, err, store.ErrMemoPermissionDenied)
	manualCounts(t, d, 1, 1)
}

func TestYoujiManualExistingPairConflicts(t *testing.T) {
	for _, mutation := range []string{
		`UPDATE memo SET content='edited'`,
		`UPDATE memo SET visibility='PUBLIC'`,
		`UPDATE memo SET row_status='ARCHIVED'`,
		`UPDATE memo SET space_id=42`,
		`UPDATE attachment SET creator_id=2`,
		`UPDATE attachment SET uid='different'`,
		`UPDATE attachment SET filename='different.zip'`,
		`UPDATE attachment SET type='text/plain'`,
		`UPDATE attachment SET size=4`,
		`UPDATE attachment SET blob=x'6e6577'`,
		`UPDATE attachment SET storage_type='LOCAL'`,
		`UPDATE attachment SET reference='external'`,
		`UPDATE attachment SET memo_id=NULL`,
		`INSERT INTO attachment(uid,creator_id,memo_id) SELECT 'extra',1,id FROM memo`,
	} {
		t.Run(mutation, func(t *testing.T) {
			d := manualTestDB(t)
			m, a := manualPair("conflict")
			_, err := d.ImportYoujiManual(t.Context(), m, a, store.YoujiManualLimits{})
			require.NoError(t, err)
			_, err = d.db.Exec(mutation)
			require.NoError(t, err)
			m, a = manualPair("conflict")
			_, err = d.ImportYoujiManual(t.Context(), m, a, store.YoujiManualLimits{})
			require.ErrorIs(t, err, store.ErrYoujiManualConflict)
			require.Zero(t, m.ID)
			require.Zero(t, a.ID)
		})
	}
}

func TestYoujiManualRollbackOnAttachmentFailure(t *testing.T) {
	d := manualTestDB(t)
	_, err := d.db.Exec(`CREATE TRIGGER fail_original BEFORE INSERT ON attachment BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`)
	require.NoError(t, err)
	m, a := manualPair("rollback")
	_, err = d.ImportYoujiManual(t.Context(), m, a, store.YoujiManualLimits{})
	require.Error(t, err)
	manualCounts(t, d, 0, 0)
	require.Zero(t, m.ID)
	require.Nil(t, a.MemoID)
	_, err = d.db.Exec(`DROP TRIGGER fail_original`)
	require.NoError(t, err)
	_, err = d.ImportYoujiManual(t.Context(), m, a, store.YoujiManualLimits{})
	require.NoError(t, err)
	manualCounts(t, d, 1, 1)
}

func TestYoujiManualDoesNotClaimOrphanUID(t *testing.T) {
	d := manualTestDB(t)
	m, a := manualPair("occupied")
	_, err := d.db.Exec(`INSERT INTO attachment(uid,creator_id,filename,blob,size) VALUES(?,2,'other.zip',x'616263',3)`, a.UID)
	require.NoError(t, err)
	_, err = d.ImportYoujiManual(t.Context(), m, a, store.YoujiManualLimits{})
	require.ErrorIs(t, err, store.ErrYoujiManualConflict)
	manualCounts(t, d, 0, 1)
	var creator int
	var linked bool
	require.NoError(t, d.db.QueryRow(`SELECT creator_id, memo_id IS NOT NULL FROM attachment WHERE uid=?`, a.UID).Scan(&creator, &linked))
	require.Equal(t, 2, creator)
	require.False(t, linked)
}

func TestYoujiManualQuotaAndOrphans(t *testing.T) {
	for name, limits := range map[string]store.YoujiManualLimits{
		"memo": {MemoCount: 1}, "storage": {StorageBytes: 5}, "upload": {UploadBytes: 2},
	} {
		t.Run(name, func(t *testing.T) {
			d := manualTestDB(t)
			m, a := manualPair("existing")
			_, err := d.ImportYoujiManual(t.Context(), m, a, store.YoujiManualLimits{})
			require.NoError(t, err)
			m, a = manualPair("second")
			_, err = d.ImportYoujiManual(t.Context(), m, a, limits)
			require.ErrorIs(t, err, store.ErrYoujiManualQuota)
			manualCounts(t, d, 1, 1)
		})
	}
	d := manualTestDB(t)
	_, err := d.db.Exec(`INSERT INTO attachment(uid,creator_id,size,storage_type) VALUES('orphan',1,4,'EXTERNAL'),('other-owner',2,100,'')`)
	require.NoError(t, err)
	m, a := manualPair("orphan-count")
	_, err = d.ImportYoujiManual(t.Context(), m, a, store.YoujiManualLimits{StorageBytes: 6})
	require.ErrorIs(t, err, store.ErrYoujiManualQuota)
	_, err = d.ImportYoujiManual(t.Context(), m, a, store.YoujiManualLimits{StorageBytes: 7, UploadBytes: 3, MemoCount: 1})
	require.NoError(t, err)
	manualCounts(t, d, 1, 3)
}

func TestYoujiManualConcurrentIdempotencyAndQuota(t *testing.T) {
	for _, same := range []bool{true, false} {
		t.Run(fmt.Sprint(same), func(t *testing.T) {
			d := manualTestDB(t)
			start := make(chan struct{})
			type result struct {
				verified bool
				err      error
			}
			results := make(chan result, 8)
			var wg sync.WaitGroup
			for i := range 8 {
				wg.Go(func() {
					uid := "same"
					if !same {
						uid = fmt.Sprintf("unique-%d", i)
					}
					m, a := manualPair(uid)
					<-start
					verified, err := d.ImportYoujiManual(t.Context(), m, a, store.YoujiManualLimits{MemoCount: 1, StorageBytes: 3})
					results <- result{verified, err}
				})
			}
			close(start)
			wg.Wait()
			close(results)
			created, verified, quota := 0, 0, 0
			for r := range results {
				switch {
				case errors.Is(r.err, store.ErrYoujiManualQuota):
					quota++
				case r.err != nil:
					t.Fatal(r.err)
				case r.verified:
					verified++
				default:
					created++
				}
			}
			require.Equal(t, 1, created)
			if same {
				require.Equal(t, 7, verified)
			} else {
				require.Equal(t, 7, quota)
			}
			manualCounts(t, d, 1, 1)
		})
	}
}

func TestYoujiManualRejectsInvalidAndCancelled(t *testing.T) {
	d := manualTestDB(t)
	for _, mutate := range []func(*store.Memo, *store.Attachment){
		func(m *store.Memo, _ *store.Attachment) { m.Visibility = store.Public },
		func(m *store.Memo, a *store.Attachment) { m.CreatorID, a.CreatorID = 99, 99 },
		func(_ *store.Memo, a *store.Attachment) { a.CreatorID = 2 },
		func(_ *store.Memo, a *store.Attachment) { a.Size++ },
		func(_ *store.Memo, a *store.Attachment) { a.StorageType = storepb.AttachmentStorageType_S3 },
	} {
		m, a := manualPair("invalid")
		mutate(m, a)
		_, err := d.ImportYoujiManual(t.Context(), m, a, store.YoujiManualLimits{})
		require.Error(t, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	m, a := manualPair("cancelled")
	_, err := d.ImportYoujiManual(ctx, m, a, store.YoujiManualLimits{})
	require.ErrorIs(t, err, context.Canceled)
	manualCounts(t, d, 0, 0)
}
