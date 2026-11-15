package fileserver

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
	apipb "github.com/usememos/memos/proto/gen/api"
	"github.com/usememos/memos/server/auth"
)

func TestYoujiLargeAudioHTTPDownloadAndExport(t *testing.T) {
	ctx := context.Background()
	f, cleanup := newMemoExportFixture(ctx, t)
	defer cleanup()
	defer f.svc.CloseUploads()
	configureLocalStorage(ctx, t, f.stores)
	ownerCtx := context.WithValue(ctx, auth.UserIDContextKey, f.member.ID)
	const payloadSize = 17 * (1024 * 1024)
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

	initial, err := f.svc.UploadAttachment(ownerCtx, &apipb.UploadAttachmentRequest{Upload: &apipb.UploadAttachmentRequest_Spec{Spec: &apipb.UploadAttachmentSpec{
		Attachment: &apipb.Attachment{Filename: "synthetic-long.wav", Type: "audio/wav"}, TotalSize: int64(len(original)),
	}}})
	require.NoError(t, err)
	var result *apipb.UploadAttachmentResponse
	for offset := 0; offset < len(original); {
		end := min(offset+int(initial.MaxChunkSize), len(original))
		result, err = f.svc.UploadAttachment(ownerCtx, &apipb.UploadAttachmentRequest{
			Upload: &apipb.UploadAttachmentRequest_UploadId{UploadId: initial.UploadId}, WriteOffset: int64(offset),
			Data: original[offset:end], FinishWrite: end == len(original),
		})
		require.NoError(t, err)
		offset = end
	}
	_, err = f.svc.CreateMemo(ownerCtx, &apipb.CreateMemoRequest{Memo: &apipb.Memo{
		Content: "Synthetic recording only", Visibility: apipb.Visibility_PRIVATE,
		Attachments: []*apipb.Attachment{{Name: result.Attachment.Name}},
	}})
	require.NoError(t, err)
	server := httptest.NewTestServer(t, f.mux)
	server.Start()
	ownerCookie := newRefreshTokenCookie(ctx, t, f.stores, f.member.ID, f.svc.Secret)
	adminCookie := newRefreshTokenCookie(ctx, t, f.stores, f.admin.ID, f.svc.Secret)
	get := func(path string, cookie *http.Cookie, rangeHeader string) (int, []byte, http.Header) {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, server.URL+path, nil)
		require.NoError(t, err)
		if cookie != nil {
			req.AddCookie(cookie)
		}
		if rangeHeader != "" {
			req.Header.Set("Range", rangeHeader)
		}
		response, err := server.Client().Do(req)
		require.NoError(t, err)
		defer response.Body.Close()
		data, err := io.ReadAll(io.LimitReader(response.Body, 40*1024*1024))
		require.NoError(t, err)
		return response.StatusCode, data, response.Header
	}
	route := "/file/" + result.Attachment.Name + "/synthetic-long.wav"
	status, data, headers := get(route, ownerCookie, "")
	require.Equal(t, http.StatusOK, status)
	require.Equal(t, len(original), len(data))
	require.Equal(t, sha256.Sum256(original), sha256.Sum256(data))
	require.Equal(t, "private, no-store", headers.Get("Cache-Control"))
	status, data, _ = get(route, nil, "")
	t.Logf("anonymous download status: %d", status)
	require.True(t, status == http.StatusUnauthorized || status == http.StatusForbidden || status == http.StatusNotFound)
	require.NotEqual(t, sha256.Sum256(original), sha256.Sum256(data))
	status, data, headers = get(route, ownerCookie, "bytes=100-999")
	require.Equal(t, http.StatusPartialContent, status)
	require.Equal(t, original[100:1000], data)
	require.NotEmpty(t, headers.Get("Content-Range"))
	exportRoute := "/file/users/" + f.member.Username + "/export"
	status, _, _ = get(exportRoute, ownerCookie, "")
	require.Equal(t, http.StatusForbidden, status, "ordinary user bulk export is not permitted by upstream")
	status, data, _ = get(exportRoute, adminCookie, "")
	require.Equal(t, http.StatusOK, status)
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	require.NoError(t, err)
	matches := 0
	for _, entry := range archive.File {
		if entry.UncompressedSize64 != uint64(len(original)) {
			continue
		}
		reader, err := entry.Open()
		require.NoError(t, err)
		content, err := io.ReadAll(io.LimitReader(reader, int64(len(original))+1))
		require.NoError(t, err)
		require.NoError(t, reader.Close())
		if sha256.Sum256(content) == sha256.Sum256(original) {
			matches++
		}
	}
	require.Equal(t, 1, matches, "export contains exactly one byte-identical original")
	t.Log("17MiB WAV: authenticated HTTP download SHA256 matches; Range=206; member export=403; admin export contains byte-identical original")
}
