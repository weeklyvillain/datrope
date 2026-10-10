package files

import (
	"bytes"
	"context"
	"errors"
	"image"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/httpx"
)

type blobTable struct{ table, column string }

// AddBlobTable registers a table whose column holds blob sums that must not
// be collected. table and column are code constants, never user input.
func (s *Service) AddBlobTable(table, column string) {
	s.blobTables = append(s.blobTables, blobTable{table, column})
}

// StoreImageBlob cleans an image and stores it, holding the blob lock in tx
// so the collector cannot remove it before tx commits.
func (s *Service) StoreImageBlob(ctx context.Context, tx pgx.Tx, data []byte) (sum, contentType string, err error) {
	ct, kind := Sniff(data[:min(len(data), 512)])
	if kind == "" {
		return "", "", httpx.BadRequest("NOT_AN_IMAGE", "upload a PNG, JPEG, WebP or GIF image")
	}
	clean, err := Clean(kind, data)
	if err != nil {
		return "", "", httpx.BadRequest("NOT_AN_IMAGE", "the image could not be read")
	}
	if _, _, err := Info(clean); err != nil {
		return "", "", httpx.BadRequest("NOT_AN_IMAGE", "the image could not be read")
	}
	staged, err := s.store.Stage(bytes.NewReader(clean), int64(len(clean)))
	if err != nil {
		return "", "", err
	}
	defer s.store.Discard(staged)
	if err := lockBlobs(ctx, tx, staged.Sum); err != nil {
		return "", "", err
	}
	if err := s.store.Commit(staged); err != nil {
		return "", "", err
	}
	return staged.Sum, ct, nil
}

// StoreBlob stores data as it is, holding the blob lock in tx so the
// collector cannot remove it before tx commits.
func (s *Service) StoreBlob(ctx context.Context, tx pgx.Tx, data []byte) (sum string, err error) {
	staged, err := s.store.Stage(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", err
	}
	defer s.store.Discard(staged)
	if err := lockBlobs(ctx, tx, staged.Sum); err != nil {
		return "", err
	}
	if err := s.store.Commit(staged); err != nil {
		return "", err
	}
	return staged.Sum, nil
}

// OpenBlob opens a stored blob for reading (music library tracks).
func (s *Service) OpenBlob(sum string) (io.ReadSeekCloser, error) { return s.store.Open(sum) }

// ServeBlob writes a stored image with the headers every public image uses.
func (s *Service) ServeBlob(w http.ResponseWriter, r *http.Request, sum, contentType string, immutable bool) {
	cache := "public, max-age=60"
	if immutable {
		cache = "public, max-age=31536000, immutable"
	}
	s.serveBlob(w, r, sum, contentType, cache)
}

// ServePrivateBlob writes a stored image that only some signed-in users may
// see (webhook avatars, webhook messages' images): only their browser caches it.
func (s *Service) ServePrivateBlob(w http.ResponseWriter, r *http.Request, sum, contentType string) {
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	s.serveBlob(w, r, sum, contentType, "private, max-age=86400")
}

func (s *Service) serveBlob(w http.ResponseWriter, r *http.Request, sum, contentType, cacheControl string) {
	f, err := s.store.Open(sum)
	if errors.Is(err, os.ErrNotExist) {
		httpx.WriteHTTPError(w, r, httpx.NotFound("image"))
		return
	}
	if err != nil {
		httpx.WriteHTTPError(w, r, err)
		return
	}
	defer f.Close()
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Cache-Control", cacheControl)
	h.Set("ETag", `"`+sum+`"`)
	http.ServeContent(w, r, "", time.Time{}, f)
}

// ImageSize reads an image's dimensions without decoding its pixels.
func (s *Service) ImageSize(data []byte) (width, height int, err error) { return Info(data) }

// CropGIF crops and scales every frame of an animated GIF; see the package function.
func (s *Service) CropGIF(data []byte, crop image.Rectangle, w, h int) ([]byte, error) {
	return CropGIF(data, crop, w, h)
}
