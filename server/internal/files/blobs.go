package files

import (
	"bytes"
	"context"
	"errors"
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

// ServeBlob writes a stored image with the headers every public image uses.
func (s *Service) ServeBlob(w http.ResponseWriter, r *http.Request, sum, contentType string, immutable bool) {
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
	if immutable {
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		h.Set("Cache-Control", "public, max-age=60")
	}
	h.Set("ETag", `"`+sum+`"`)
	http.ServeContent(w, r, "", time.Time{}, f)
}

// ImageSize reads an image's dimensions without decoding its pixels.
func (s *Service) ImageSize(data []byte) (width, height int, err error) { return Info(data) }
