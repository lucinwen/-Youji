package api

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/usememos/memos/internal/profile"
)

func TestYoujiManualIdentityMatchesFrontend(t *testing.T) {
	for _, tc := range []struct{ name, id string }{
		{"合成聊天.txt", "mwt-16f1c0e0215a4d3d98a2181946e3c7"},
		{"<合成&>\u2028.txt", "mwt-11b723230229d1f958c48277bd6295"},
		{`literal\u2028.txt`, "mwt-980069c48257c2cdc55af780d8ddc6"},
	} {
		id, sum := youjiManualIdentity("users/42", tc.name, []byte("合成\r\n"))
		require.Equal(t, tc.id, id)
		require.Equal(t, "4bd77980dde529b5cc004622cd7c17be4e7bdad4fefe6085e6d50912792e39c4", sum)
		other, _ := youjiManualIdentity("users/43", tc.name, []byte("合成\r\n"))
		require.NotEqual(t, id, other)
	}
}

func TestYoujiManualArchiveBoundedAndDeterministic(t *testing.T) {
	input := youjiManualRequest{Filename: "合成.md", Content: "# 合成", Data: []byte("\xef\xbb\xbf原文\r\n<script>not executable</script>")}
	first, err := youjiManualArchive(input)
	require.NoError(t, err)
	second, err := youjiManualArchive(input)
	require.NoError(t, err)
	require.Equal(t, first, second)
	reader, err := zip.NewReader(bytes.NewReader(first), int64(len(first)))
	require.NoError(t, err)
	require.Len(t, reader.File, 1)
	require.Equal(t, input.Filename, reader.File[0].Name)
	file, err := reader.File[0].Open()
	require.NoError(t, err)
	defer file.Close()
	raw, err := io.ReadAll(file)
	require.NoError(t, err)
	require.Equal(t, input.Data, raw)
	for _, name := range []string{"../bad.txt", "dir/bad.txt", `dir\bad.txt`, "bad\n.txt", "bad.html", ""} {
		invalid := input
		invalid.Filename = name
		_, err := youjiManualArchive(invalid)
		require.Error(t, err)
	}
	for _, data := range [][]byte{nil, {0xff}, bytes.Repeat([]byte("a"), (128<<10)+1)} {
		invalid := input
		invalid.Data = data
		_, err := youjiManualArchive(invalid)
		require.Error(t, err)
	}
	invalid := input
	invalid.Content = string(bytes.Repeat([]byte("a"), (256<<10)+1))
	_, err = youjiManualArchive(invalid)
	require.Error(t, err)
}

func TestYoujiManualGatewayRequiresAuthentication(t *testing.T) {
	service := &APIService{Profile: &profile.Profile{}}
	handler, err := service.NewHandler(t.Context())
	require.NoError(t, err)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("POST", "/api/youji/manual-text/import", bytes.NewBufferString(`{"owner":"users/1"}`)))
	require.Equal(t, 401, response.Code)
	require.Contains(t, response.Header().Get("Cache-Control"), "no-store")
}
