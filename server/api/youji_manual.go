package api

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
	"github.com/usememos/memos/core/usagelimit"
	"github.com/usememos/memos/internal/ratelimit"
	apipb "github.com/usememos/memos/proto/gen/api"
	"github.com/usememos/memos/store"
)

type youjiManualRequest struct {
	Owner    string `json:"owner"`
	Filename string `json:"filename"`
	Content  string `json:"content"`
	Data     []byte `json:"data"`
}

func (s *APIService) registerYoujiManualRoutes(mux *runtime.ServeMux) error {
	// Unresolved custom paths are protected by the shared gateway authorizer.
	if err := mux.HandlePath(http.MethodPost, "/api/youji/manual-text/import", s.importYoujiManual); err != nil {
		return err
	}
	if err := mux.HandlePath(http.MethodPost, "/api/youji/html-text/import", s.importYoujiHTML); err != nil {
		return err
	}
	return mux.HandlePath(http.MethodPost, "/api/youji/chat-json/import", s.importYoujiChat)
}

// The route selects this specification; clients cannot choose the identity namespace or limits.
type youjiTextSpec struct {
	domain, memoPrefix, attachmentPrefix string
	extensions                           []string
	rawLimit, requestLimit               int64
}

func manualTextSpec() youjiTextSpec {
	return youjiTextSpec{"manual-text-v1", "mwt-", "ymt-", []string{".txt", ".md"}, 128 << 10, 2 << 20}
}

func htmlTextSpec() youjiTextSpec {
	return youjiTextSpec{"html-text-v1", "mwh-", "ymh-", []string{".html", ".htm"}, 512 << 10, 3 << 20}
}

func chatTextSpec() youjiTextSpec {
	return youjiTextSpec{"telegram-chat-v1", "mwc-", "ymc-", []string{".json"}, 512 << 10, 3 << 20}
}

func youjiManualIdentity(owner, filename string, data []byte) (string, string) {
	return youjiTextIdentity(manualTextSpec(), owner, filename, data)
}

func youjiTextIdentity(spec youjiTextSpec, owner, filename string, data []byte) (string, string) {
	digest := sha256.Sum256(data)
	sum := hex.EncodeToString(digest[:])
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode([]string{spec.domain, owner, sum, filename})
	// Match JSON.stringify, including its literal U+2028/U+2029. Preserve escaped backslashes.
	raw := bytes.TrimSuffix(encoded.Bytes(), []byte{'\n'})
	var key bytes.Buffer
	for i := 0; i < len(raw); i++ {
		if raw[i] == '\\' && i+1 < len(raw) {
			if i+6 <= len(raw) && (string(raw[i:i+6]) == `\u2028` || string(raw[i:i+6]) == `\u2029`) {
				if raw[i+5] == '8' {
					key.WriteRune('\u2028')
				} else {
					key.WriteRune('\u2029')
				}
				i += 5
				continue
			}
			key.WriteByte(raw[i])
			i++
			key.WriteByte(raw[i])
			continue
		}
		key.WriteByte(raw[i])
	}
	identity := sha256.Sum256(key.Bytes())
	return spec.memoPrefix + hex.EncodeToString(identity[:])[:30], sum
}

func youjiManualArchive(request youjiManualRequest) ([]byte, error) {
	return youjiTextArchive(manualTextSpec(), request)
}

// Preserve the original bytes in a ZIP; do not parse HTML, execute it, or fetch its references.
func youjiTextArchive(spec youjiTextSpec, request youjiManualRequest) ([]byte, error) {
	extensionAllowed := false
	for _, extension := range spec.extensions {
		extensionAllowed = extensionAllowed || strings.HasSuffix(strings.ToLower(request.Filename), extension)
	}
	if len(request.Data) == 0 || int64(len(request.Data)) > spec.rawLimit || len(request.Content) == 0 || len(request.Content) > 256<<10 ||
		!utf8.Valid(request.Data) || !utf8.ValidString(request.Content) || !utf8.ValidString(request.Filename) ||
		utf8.RuneCountInString(request.Filename) > 240 || !validateFilename(request.Filename) ||
		!extensionAllowed {
		return nil, errors.New("invalid manual input")
	}
	// Match the frontend UTF-8 decoder's BOM handling for syntax validation only.
	// Hashing and ZIP storage retain every original byte. This is not Telegram schema validation.
	if spec.domain == "telegram-chat-v1" && !json.Valid(bytes.TrimPrefix(request.Data, []byte{0xef, 0xbb, 0xbf})) {
		return nil, errors.New("invalid chat JSON")
	}
	for _, r := range request.Filename {
		if r < 32 || r == 127 {
			return nil, errors.New("invalid filename")
		}
	}
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	entry, err := writer.CreateHeader(&zip.FileHeader{Name: request.Filename, Method: zip.Store})
	if err != nil {
		return nil, err
	}
	if _, err = entry.Write(request.Data); err != nil {
		return nil, err
	}
	if err = writer.Close(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func (s *APIService) importYoujiManual(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	s.importYoujiText(w, r, manualTextSpec())
}

func (s *APIService) importYoujiHTML(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	s.importYoujiText(w, r, htmlTextSpec())
}

func (s *APIService) importYoujiChat(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	s.importYoujiText(w, r, chatTextSpec())
}

func (s *APIService) importYoujiText(w http.ResponseWriter, r *http.Request, spec youjiTextSpec) {
	ctx := r.Context()
	user, err := s.fetchCurrentUser(ctx)
	if err != nil || user == nil {
		youjiPDFError(w, 401, "authentication_required")
		return
	}
	importer, supported := s.Store.GetDriver().(store.YoujiManualImporter)
	if !supported {
		youjiPDFError(w, 501, "sqlite_manual_import_required")
		return
	}
	if err := s.throttleAndCharge(ratelimit.ScopeWriteUser, userKey(user.ID), 1); err != nil {
		youjiPDFError(w, 429, "busy")
		return
	}
	if err := s.throttleAndCharge(ratelimit.ScopeUploadUser, userKey(user.ID), 1); err != nil {
		youjiPDFError(w, 429, "busy")
		return
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, spec.requestLimit))
	decoder.DisallowUnknownFields()
	var input youjiManualRequest
	if err := decoder.Decode(&input); err != nil {
		youjiPDFError(w, 422, "invalid_input")
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		youjiPDFError(w, 422, "invalid_input")
		return
	}
	owner := BuildUserName(user.Username)
	if input.Owner != owner {
		youjiPDFError(w, 403, "account_changed")
		return
	}
	blob, err := youjiTextArchive(spec, input)
	if err != nil {
		youjiPDFError(w, 422, "invalid_input")
		return
	}
	id, sum := youjiTextIdentity(spec, owner, input.Filename, input.Data)
	prepared, err := s.prepareMemoCreate(ctx, user, &apipb.Memo{Content: input.Content, Visibility: apipb.Visibility_PRIVATE}, id)
	if err != nil || len(prepared.requiredAttachmentIDs) > 0 || len(prepared.referenceRelations) > 0 {
		youjiPDFError(w, 422, "invalid_content_or_content_quota")
		return
	}
	effective, err := usagelimit.EffectiveFor(ctx, s.Store, user.ID)
	if err != nil {
		youjiPDFError(w, 503, "limits_unavailable")
		return
	}
	original := &store.Attachment{UID: spec.attachmentPrefix + strings.TrimPrefix(id, spec.memoPrefix), CreatorID: user.ID, Filename: input.Filename + ".original.zip", Type: "application/zip", Size: int64(len(blob)), Blob: blob}
	verified, err := importer.ImportYoujiManual(ctx, prepared.memo, original, store.YoujiManualLimits{
		MemoCount: effective.Entry.GetMemoCount(), StorageBytes: effective.Entry.GetStorageBytes(), UploadBytes: effective.Entry.GetUploadBytes(),
	})
	if err != nil {
		switch {
		case errors.Is(err, store.ErrYoujiManualConflict):
			youjiPDFError(w, 409, "original_or_content_conflict")
		case errors.Is(err, store.ErrYoujiManualQuota):
			youjiPDFError(w, 429, "quota_exceeded")
		case errors.Is(err, store.ErrMemoSpaceMembershipRequired), errors.Is(err, store.ErrMemoPermissionDenied):
			youjiPDFError(w, 403, "account_unavailable")
		default:
			youjiPDFError(w, 503, "save_unconfirmed_retry_same_input")
		}
		return
	}
	state := "imported"
	if verified {
		state = "verified"
	} else {
		s.SSEHub.publishMemoChanged()
	}
	youjiPDFJSON(w, 200, map[string]string{"memo": "memos/" + id, "attachment": "attachments/" + original.UID, "sha256": sum, "status": state})
}
