package auth

import (
	"bytes"
	"context"
	"errors"
	"image"
	"io"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

// Blobs is what this package needs from files: cleaned, stored images.
type Blobs interface {
	StoreImageBlob(ctx context.Context, tx pgx.Tx, data []byte) (sum, contentType string, err error)
	ImageSize(data []byte) (width, height int, err error)
	CropGIF(data []byte, crop image.Rectangle, w, h int) ([]byte, error)
	RemoveBlobs(ctx context.Context, sums []string) error
	ServeBlob(w http.ResponseWriter, r *http.Request, sum, contentType string, immutable bool)
}

func (s *Service) SetBlobs(b Blobs) { s.blobs = b }

const (
	// MaxAvatarBytes caps the upload: the web app sends a small 256 × 256 crop,
	// or an uncropped GIF for the server to crop.
	MaxAvatarBytes = 2 << 20
	maxAvatarSide  = 1024
)

// imageKind describes one per-user image (avatar or banner): its columns on
// users, its public URL, and its limits. The column names are constants,
// never user input.
type imageKind struct {
	col      string // "avatar" -> avatar_sha256, avatar_content_type
	path     string // public URL prefix, "/api/avatars/"
	maxBytes int
	maxSide  int
	outW     int // a cropped GIF is scaled to outW × outH
	outH     int
	limitMsg string
	sizeMsg  string
}

var (
	avatarKind = imageKind{col: "avatar", path: "/api/avatars/", maxBytes: MaxAvatarBytes, maxSide: maxAvatarSide, outW: 256, outH: 256,
		limitMsg: "avatars can be at most 2 MB", sizeMsg: "avatars can be at most 1024 × 1024 pixels"}
	bannerKind = imageKind{col: "banner", path: "/api/banners/", maxBytes: MaxBannerBytes, maxSide: maxBannerSide, outW: 960, outH: 320,
		limitMsg: "banners can be at most 5 MB", sizeMsg: "banners can be at most 2048 × 2048 pixels"}
)

func (k imageKind) sumCol() string  { return k.col + "_sha256" }
func (k imageKind) typeCol() string { return k.col + "_content_type" }

// imageURL is the public, versioned URL of a user's image, or "" when they have none.
func (k imageKind) imageURL(userID id.ID, sum *string) string {
	if sum == nil || len(*sum) < 12 {
		return ""
	}
	return k.path + userID.String() + "?v=" + (*sum)[:12]
}

func writeUser(w http.ResponseWriter, r *http.Request, u *User, err error) {
	if err != nil {
		httpx.WriteHTTPError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, u)
}

// readImageUpload reads and validates the multipart "file" field: size cap,
// image type and dimensions. Browsers can only crop a GIF's first frame, so
// the web app sends a GIF uncropped with crop_x, crop_y, crop_w and crop_h
// (source pixels); the server crops every frame so it stays animated.
func (s *Service) readImageUpload(w http.ResponseWriter, r *http.Request, k imageKind) ([]byte, error) {
	tooLarge := httpx.E(http.StatusRequestEntityTooLarge, "TOO_LARGE", k.limitMsg)
	limit := int64(k.maxBytes) + 64<<10
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	if err := r.ParseMultipartForm(limit); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return nil, tooLarge
		}
		return nil, httpx.BadRequest("VALIDATION_FAILED", "expected a multipart/form-data body")
	}
	defer func() { _ = r.MultipartForm.RemoveAll() }()
	f, hdr, err := r.FormFile("file")
	if err != nil {
		return nil, httpx.BadRequest("MISSING_FILE", `the form has no "file" field`)
	}
	defer f.Close()
	if hdr.Size > int64(k.maxBytes) {
		return nil, tooLarge
	}
	data, err := io.ReadAll(io.LimitReader(f, int64(k.maxBytes)+1))
	if err != nil {
		return nil, err
	}
	if len(data) > k.maxBytes {
		return nil, tooLarge
	}
	width, height, err := s.blobs.ImageSize(data)
	if err != nil {
		return nil, httpx.BadRequest("NOT_AN_IMAGE", "upload a PNG, JPEG, WebP or GIF image")
	}
	if width > k.maxSide || height > k.maxSide {
		return nil, httpx.BadRequest("IMAGE_TOO_BIG", k.sizeMsg)
	}
	crop, ok, err := cropFields(r)
	if err != nil || !ok {
		return data, err
	}
	if !bytes.HasPrefix(data, []byte("GIF8")) {
		return nil, httpx.BadRequest("VALIDATION_FAILED", "only a GIF can be cropped by the server")
	}
	if !crop.In(image.Rect(0, 0, width, height)) {
		return nil, httpx.BadRequest("VALIDATION_FAILED", "the crop must lie inside the image")
	}
	data, err = s.blobs.CropGIF(data, crop, k.outW, k.outH)
	if err != nil {
		return nil, httpx.BadRequest("NOT_AN_IMAGE", "the GIF could not be cropped; it may have too many frames")
	}
	return data, nil
}

// cropFields reads the optional crop_x, crop_y, crop_w and crop_h form
// fields: all or none.
func cropFields(r *http.Request) (image.Rectangle, bool, error) {
	var v [4]int
	n := 0
	for i, name := range [4]string{"crop_x", "crop_y", "crop_w", "crop_h"} {
		vals := r.MultipartForm.Value[name]
		if len(vals) == 0 {
			continue
		}
		x, err := strconv.Atoi(vals[0])
		if err != nil || x < 0 {
			return image.Rectangle{}, false, httpx.BadRequest("VALIDATION_FAILED", name+" must be a whole number of pixels")
		}
		v[i] = x
		n++
	}
	switch {
	case n == 0:
		return image.Rectangle{}, false, nil
	case n < 4 || v[2] == 0 || v[3] == 0:
		return image.Rectangle{}, false, httpx.BadRequest("VALIDATION_FAILED", "a crop needs crop_x, crop_y, crop_w and crop_h, with a positive size")
	}
	return image.Rect(v[0], v[1], v[0]+v[2], v[1]+v[3]), true, nil
}

func (s *Service) imageUploadHandler(k imageKind) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, err := s.uploadImage(w, r, k)
		writeUser(w, r, u, err)
	})
}

func (s *Service) uploadImage(w http.ResponseWriter, r *http.Request, k imageKind) (*User, error) {
	ctx := r.Context()
	me := Current(ctx).User.ID
	data, err := s.readImageUpload(w, r, k)
	if err != nil {
		return nil, err
	}
	tx, err := s.store.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var old *string
	if err := tx.QueryRow(ctx, `SELECT `+k.sumCol()+` FROM users WHERE id = $1 FOR UPDATE`, me).Scan(&old); err != nil {
		return nil, err
	}
	sum, ct, err := s.blobs.StoreImageBlob(ctx, tx, data) // sniffs the type and strips metadata
	if err != nil {
		return nil, err
	}
	u, err := scanUser(tx.QueryRow(ctx,
		`UPDATE users u SET `+k.sumCol()+` = $2, `+k.typeCol()+` = $3 WHERE u.id = $1 RETURNING `+userCols, me, sum, ct))
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if old != nil && *old != sum {
		if err := s.blobs.RemoveBlobs(ctx, []string{*old}); err != nil {
			slog.WarnContext(ctx, "auth: removing the old "+k.col+"; the sweep will retry", "err", err)
		}
	}
	s.publishUser(u)
	return u, nil
}

func (s *Service) imageDeleteHandler(k imageKind) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		me := Current(ctx).User.ID
		u, old, err := s.clearImage(ctx, k, me)
		if err == nil && old != nil {
			if rerr := s.blobs.RemoveBlobs(ctx, []string{*old}); rerr != nil {
				slog.WarnContext(ctx, "auth: removing a "+k.col+"; the sweep will retry", "err", rerr)
			}
			s.publishUser(u)
		}
		writeUser(w, r, u, err)
	})
}

// clearImage nulls the user's image columns and returns the user and the hash
// it had, read under a row lock so a concurrent upload cannot slip between.
func (s *Service) clearImage(ctx context.Context, k imageKind, me id.ID) (*User, *string, error) {
	tx, err := s.store.db.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback(ctx)
	var old *string
	if err := tx.QueryRow(ctx, `SELECT `+k.sumCol()+` FROM users WHERE id = $1 FOR UPDATE`, me).Scan(&old); err != nil {
		return nil, nil, err
	}
	u, err := scanUser(tx.QueryRow(ctx,
		`UPDATE users u SET `+k.sumCol()+` = NULL, `+k.typeCol()+` = NULL WHERE u.id = $1 RETURNING `+userCols, me))
	if err != nil {
		return nil, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	return u, old, nil
}

func (s *Service) imageServeHandler(k imageKind) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uid, err := httpx.ParseID(r.PathValue("userID"), "user")
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		var sum, ct string
		err = s.store.db.QueryRow(r.Context(),
			`SELECT `+k.sumCol()+`, `+k.typeCol()+` FROM users WHERE id = $1 AND `+k.sumCol()+` IS NOT NULL`, uid).Scan(&sum, &ct)
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.WriteHTTPError(w, r, httpx.NotFound(k.col))
			return
		}
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		// Only the URL with the current version may be cached for ever.
		s.blobs.ServeBlob(w, r, sum, ct, len(sum) >= 12 && r.URL.Query().Get("v") == sum[:12])
	})
}

// AvatarUploadHandler serves PUT /api/users/@me/avatar (multipart "file"),
// AvatarDeleteHandler DELETE of the same, and AvatarHandler the public
// GET /api/avatars/{userID}. The first two must run behind RequireHTTP.
func (s *Service) AvatarUploadHandler() http.Handler { return s.imageUploadHandler(avatarKind) }
func (s *Service) AvatarDeleteHandler() http.Handler { return s.imageDeleteHandler(avatarKind) }
func (s *Service) AvatarHandler() http.Handler       { return s.imageServeHandler(avatarKind) }
