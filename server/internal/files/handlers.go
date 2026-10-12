package files

import (
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
)

// multipartOverhead is the room allowed for form headers around the file.
const multipartOverhead = 1 << 20

// UploadHandler serves POST /api/attachments?channel_id=<id> or ?album_id=<id>
// with the file in a multipart field named "file". It must run behind auth.RequireHTTP.
func (s *Service) UploadHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a, err := s.upload(w, r)
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		httpx.WriteJSON(w, http.StatusCreated, a)
	})
}

func (s *Service) upload(w http.ResponseWriter, r *http.Request) (*Attachment, error) {
	ctx := r.Context()
	me := auth.Current(ctx).User.ID
	var h home
	var limit int64
	if raw := r.URL.Query().Get("album_id"); raw != "" && s.albums != nil {
		albumID, err := httpx.ParseID(raw, "album")
		if err != nil {
			return nil, err
		}
		if err := s.albums.CheckUpload(ctx, me, albumID); err != nil {
			return nil, err
		}
		set, err := s.settings.Settings(ctx)
		if err != nil {
			return nil, err
		}
		h.albumID, limit = &albumID, set.MaxUploadBytes
	} else {
		channelID, err := httpx.ParseID(r.URL.Query().Get("channel_id"), "channel")
		if err != nil {
			return nil, err
		}
		if limit, err = s.UploadLimit(ctx, me, channelID); err != nil {
			return nil, err
		}
		h.channelID = &channelID
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit+multipartOverhead)
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, httpx.BadRequest("VALIDATION_FAILED", "expected a multipart/form-data body")
	}
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			return nil, httpx.BadRequest("MISSING_FILE", `the form has no "file" field`)
		}
		if err != nil {
			return nil, uploadError(err, limit)
		}
		if part.FormName() != "file" {
			_, _ = io.Copy(io.Discard, part)
			continue
		}
		staged, err := s.store.Stage(part, limit)
		if err != nil {
			return nil, uploadError(err, limit)
		}
		a, err := s.save(ctx, h, me, cleanFilename(part.FileName()), staged, nil)
		if err == nil && h.albumID != nil {
			s.albums.Uploaded(ctx, *h.albumID, a.ID, me)
		}
		return a, err
	}
}

func uploadError(err error, limit int64) error {
	var tooBig *http.MaxBytesError
	if errors.Is(err, ErrTooLarge) || errors.As(err, &tooBig) {
		return httpx.E(http.StatusRequestEntityTooLarge, "TOO_LARGE", fmt.Sprintf("files can be at most %d bytes", limit))
	}
	return httpx.BadRequest("VALIDATION_FAILED", "could not read the upload: "+err.Error())
}

// cleanFilename keeps the last path element, drops control characters and
// quotes, and caps the length.
func cleanFilename(name string) string {
	name = path.Base(strings.ReplaceAll(name, `\`, "/"))
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == '"' {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == "/" {
		return "file"
	}
	if utf8.RuneCountInString(name) > 255 {
		name = string([]rune(name)[:255])
	}
	return name
}

// DownloadHandler serves GET /api/attachments/{id} or, with thumbnail set,
// GET /api/attachments/{id}/thumbnail. It must run behind auth.RequireHTTP.
func (s *Service) DownloadHandler(thumbnail bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := s.download(w, r, thumbnail); err != nil {
			httpx.WriteHTTPError(w, r, err)
		}
	})
}

func (s *Service) download(w http.ResponseWriter, r *http.Request, thumbnail bool) error {
	a, err := s.authorized(r.Context(), r.PathValue("id"))
	if err != nil {
		return err
	}
	sum, ct, disposition := a.sum, "application/octet-stream", "attachment"
	if a.Inline || Playable(a.ContentType) {
		ct, disposition = a.ContentType, "inline"
	}
	if thumbnail {
		if a.thumbSum == "" {
			return httpx.NotFound("thumbnail")
		}
		sum = a.thumbSum
	}
	var f io.ReadSeekCloser
	etag, failed := `"`+sum+`"`, false
	if thumbnail || !a.Inline {
		f, err = s.store.Open(sum)
	} else {
		f, ct, etag, failed, err = s.openImage(w, r, sum, ct)
	}
	if errors.Is(err, os.ErrNotExist) {
		return httpx.NotFound("attachment")
	}
	if err != nil {
		return err
	}
	defer f.Close()
	if thumbnail { // legacy thumbnails are JPEG or PNG; tell them apart by content
		head := make([]byte, 512)
		n, _ := io.ReadFull(f, head)
		ct = http.DetectContentType(head[:n])
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return err
		}
	}
	cache := "private, max-age=86400"
	if failed {
		cache = "no-cache" // a later request may get the small copy
	}
	name := a.Filename
	if !thumbnail && a.Inline && ct != a.ContentType { // a variant in another format, e.g. WebP
		if exts, _ := mime.ExtensionsByType(ct); len(exts) > 0 {
			name = strings.TrimSuffix(name, path.Ext(name)) + exts[0]
		}
	}
	h := w.Header()
	h.Set("Content-Type", ct)
	if cd := mime.FormatMediaType(disposition, map[string]string{"filename": name}); cd != "" {
		h.Set("Content-Disposition", cd)
	} else {
		h.Set("Content-Disposition", disposition)
	}
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	h.Set("Cache-Control", cache)
	h.Set("ETag", etag)
	http.ServeContent(w, r, "", time.Time{}, f)
	return nil
}
