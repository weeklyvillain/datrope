package auth

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/httpx"
)

// Blobs is what this package needs from files: cleaned, stored images.
type Blobs interface {
	StoreImageBlob(ctx context.Context, tx pgx.Tx, data []byte) (sum, contentType string, err error)
	ImageSize(data []byte) (width, height int, err error)
	RemoveBlobs(ctx context.Context, sums []string) error
	ServeBlob(w http.ResponseWriter, r *http.Request, sum, contentType string, immutable bool)
}

func (s *Service) SetBlobs(b Blobs) { s.blobs = b }

const (
	// MaxAvatarBytes caps the upload; the web app sends a 256 × 256 crop well below it.
	MaxAvatarBytes = 512 << 10
	maxAvatarSide  = 1024
)

func errAvatarTooLarge() *httpx.Error {
	return httpx.E(http.StatusRequestEntityTooLarge, "TOO_LARGE", "avatars can be at most 512 KB")
}

func writeUser(w http.ResponseWriter, r *http.Request, u *User, err error) {
	if err != nil {
		httpx.WriteHTTPError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, u)
}

// AvatarUploadHandler serves PUT /api/users/@me/avatar (multipart "file").
// It must run behind RequireHTTP.
func (s *Service) AvatarUploadHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, err := s.uploadAvatar(w, r)
		writeUser(w, r, u, err)
	})
}

func (s *Service) uploadAvatar(w http.ResponseWriter, r *http.Request) (*User, error) {
	ctx := r.Context()
	me := Current(ctx).User.ID
	r.Body = http.MaxBytesReader(w, r.Body, MaxAvatarBytes+64<<10)
	if err := r.ParseMultipartForm(MaxAvatarBytes + 64<<10); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return nil, errAvatarTooLarge()
		}
		return nil, httpx.BadRequest("VALIDATION_FAILED", "expected a multipart/form-data body")
	}
	defer func() { _ = r.MultipartForm.RemoveAll() }()
	f, hdr, err := r.FormFile("file")
	if err != nil {
		return nil, httpx.BadRequest("MISSING_FILE", `the form has no "file" field`)
	}
	defer f.Close()
	if hdr.Size > MaxAvatarBytes {
		return nil, errAvatarTooLarge()
	}
	data, err := io.ReadAll(io.LimitReader(f, MaxAvatarBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > MaxAvatarBytes {
		return nil, errAvatarTooLarge()
	}
	width, height, err := s.blobs.ImageSize(data)
	if err != nil {
		return nil, httpx.BadRequest("NOT_AN_IMAGE", "upload a PNG, JPEG, WebP or GIF image")
	}
	if width > maxAvatarSide || height > maxAvatarSide {
		return nil, httpx.BadRequest("IMAGE_TOO_BIG", "avatars can be at most 1024 × 1024 pixels")
	}

	tx, err := s.store.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var old *string
	if err := tx.QueryRow(ctx, `SELECT avatar_sha256 FROM users WHERE id = $1 FOR UPDATE`, me).Scan(&old); err != nil {
		return nil, err
	}
	sum, ct, err := s.blobs.StoreImageBlob(ctx, tx, data) // sniffs the type and strips metadata
	if err != nil {
		return nil, err
	}
	u, err := scanUser(tx.QueryRow(ctx,
		`UPDATE users u SET avatar_sha256 = $2, avatar_content_type = $3 WHERE u.id = $1 RETURNING `+userCols, me, sum, ct))
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if old != nil && *old != sum {
		if err := s.blobs.RemoveBlobs(ctx, []string{*old}); err != nil {
			slog.WarnContext(ctx, "auth: removing the old avatar; the sweep will retry", "err", err)
		}
	}
	s.publishUser(u)
	return u, nil
}

// AvatarDeleteHandler serves DELETE /api/users/@me/avatar. It must run behind RequireHTTP.
func (s *Service) AvatarDeleteHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		me := Current(ctx).User.ID
		var old *string
		if err := s.store.db.QueryRow(ctx, `SELECT avatar_sha256 FROM users WHERE id = $1`, me).Scan(&old); err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		u, err := scanUser(s.store.db.QueryRow(ctx,
			`UPDATE users u SET avatar_sha256 = NULL, avatar_content_type = NULL WHERE u.id = $1 RETURNING `+userCols, me))
		if err == nil && old != nil {
			if rerr := s.blobs.RemoveBlobs(ctx, []string{*old}); rerr != nil {
				slog.WarnContext(ctx, "auth: removing an avatar; the sweep will retry", "err", rerr)
			}
			s.publishUser(u)
		}
		writeUser(w, r, u, err)
	})
}

// AvatarHandler serves GET /api/avatars/{userID} without a session.
func (s *Service) AvatarHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uid, err := httpx.ParseID(r.PathValue("userID"), "user")
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		var sum, ct string
		err = s.store.db.QueryRow(r.Context(),
			`SELECT avatar_sha256, avatar_content_type FROM users WHERE id = $1 AND avatar_sha256 IS NOT NULL`, uid).Scan(&sum, &ct)
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.WriteHTTPError(w, r, httpx.NotFound("avatar"))
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
