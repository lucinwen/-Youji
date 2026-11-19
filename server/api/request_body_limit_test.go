package api

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

// Only procedures that carry file bytes inline keep the large body cap; every
// other request is bounded by the general cap so buffered bodies cannot be
// used to exhaust memory.
func TestRequestBodyLimitPerProcedure(t *testing.T) {
	require.EqualValues(t, uploadRequestLimit, requestBodyLimit(attachmentUploadProcedure))
	require.EqualValues(t, uploadRequestLimit, requestBodyLimit(importMemosProcedure))
	require.EqualValues(t, MaxAPIRequestBytes, requestBodyLimit("/memos.api.AttachmentService/CreateAttachment"))
	require.EqualValues(t, MaxAPIRequestBytes, requestBodyLimit("/memos.api.AIService/Transcribe"))
	for _, procedure := range []string{
		"/memos.api.AuthService/SignIn",
		"/memos.api.UserService/CreateUser",
		"/memos.api.MemoService/CreateMemo",
		"/memos.api.MemoService/ListMemos",
	} {
		require.EqualValues(t, maxGeneralRequestBytes, requestBodyLimit(procedure), procedure)
	}
	require.Less(t, int64(maxGeneralRequestBytes), int64(MaxAPIRequestBytes))
}

func TestRequestBodyLimitGatewayAudioOnly(t *testing.T) {
	const audioPath = "/api/youji/audio-original/import"
	require.EqualValues(t, 24<<20, gatewayRequestBodyLimit("", http.MethodPost, audioPath))
	require.Equal(t, audioOriginalSpec().requestLimit, gatewayRequestBodyLimit("", http.MethodPost, audioPath))
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions, http.MethodHead, "post", ""} {
		require.Equal(t, requestBodyLimit(""), gatewayRequestBodyLimit("", method, audioPath), method)
	}
	for _, path := range []string{
		"", "/api/youji/audio-original/import/", "/api/youji/audio-original/import-extra",
		"/api/youji/audio-original/../audio-original/import", "/api/youji/%61udio-original/import",
		"/api/youji/audio-original%2Fimport", "/api/youji/audio-original/import?x=1",
		"/api/youji/audio/transcribe", "/api/youji/manual-text/import", "/api/youji/html-text/import",
		"/api/youji/chat-json/import", "/api/youji/pdf/parse", "/api/attachments",
	} {
		require.Equal(t, requestBodyLimit(""), gatewayRequestBodyLimit("", http.MethodPost, path), path)
	}
	for _, procedure := range []string{
		attachmentUploadProcedure, importMemosProcedure, "/memos.api.AttachmentService/CreateAttachment",
		"/memos.api.AIService/Transcribe", "/memos.api.MemoService/CreateMemo", "unknown-procedure",
	} {
		require.Equal(t, requestBodyLimit(procedure), gatewayRequestBodyLimit(procedure, http.MethodPost, audioPath), procedure)
	}
}
