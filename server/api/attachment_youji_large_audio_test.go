package api

import (
	"crypto/sha256"
	"encoding/binary"
	"os"
	"testing"

	"github.com/stretchr/testify/require"

	apipb "github.com/usememos/memos/proto/gen/api"
	"github.com/usememos/memos/store"
)

// TestYoujiLargeAudioOriginal uses generated PCM silence, not a private recording.
func TestYoujiLargeAudioOriginal(t *testing.T) {
	svc, ctx := newUploadTestService(t)
	const payloadSize = 17 * MebiByte
	original := make([]byte, 44+payloadSize)
	copy(original, "RIFF")
	binary.LittleEndian.PutUint32(original[4:], uint32(len(original)-8))
	copy(original[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(original[16:], 16)
	binary.LittleEndian.PutUint16(original[20:], 1)
	binary.LittleEndian.PutUint16(original[22:], 1)
	binary.LittleEndian.PutUint32(original[24:], 16000)
	binary.LittleEndian.PutUint32(original[28:], 32000)
	binary.LittleEndian.PutUint16(original[32:], 2)
	binary.LittleEndian.PutUint16(original[34:], 16)
	copy(original[36:], "data")
	binary.LittleEndian.PutUint32(original[40:], payloadSize)

	spec := uploadSpec("synthetic-long.wav", int64(len(original)))
	spec.Spec.Attachment.Type = "audio/wav"
	initial, err := svc.UploadAttachment(ctx, &apipb.UploadAttachmentRequest{Upload: spec})
	require.NoError(t, err)
	var result *apipb.UploadAttachmentResponse
	for offset := 0; offset < len(original); {
		end := min(offset+int(initial.MaxChunkSize), len(original))
		result, err = svc.UploadAttachment(ctx, &apipb.UploadAttachmentRequest{
			Upload: uploadID(initial.UploadId), WriteOffset: int64(offset),
			Data: original[offset:end], FinishWrite: end == len(original),
		})
		require.NoError(t, err)
		offset = end
	}
	require.EqualValues(t, len(original), result.Attachment.Size)
	rows, err := svc.Store.ListAttachments(ctx, &store.FindAttachment{})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	stored, err := os.ReadFile(rows[0].Reference)
	require.NoError(t, err)
	require.Equal(t, sha256.Sum256(original), sha256.Sum256(stored))
}
