package files

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// Server is what this package needs from communities.
type Server interface {
	BasePerms(ctx context.Context, userID id.ID) (perms.Perms, error)
	PublishServerUpdate(ctx context.Context) error
}

func (s *Service) SetServer(sv Server) { s.server = sv }

const maxServerImageBytes = 8 << 20

// ServerImageURLs returns the icon and banner URLs, "" when unset.
func (s *Service) ServerImageURLs(ctx context.Context) (icon, banner string, err error) {
	rows, err := s.db.Query(ctx, `SELECT kind, sha256 FROM server_images WHERE kind IN ('icon', 'banner')`)
	if err != nil {
		return "", "", err
	}
	defer rows.Close()
	for rows.Next() {
		var kind, sum string
		if err := rows.Scan(&kind, &sum); err != nil {
			return "", "", err
		}
		u := "/api/server/" + kind + "?v=" + sum[:12]
		if kind == "icon" {
			icon = u
		} else {
			banner = u
		}
	}
	return icon, banner, rows.Err()
}

func (s *Service) requireManageServer(ctx context.Context) error {
	p, err := s.server.BasePerms(ctx, auth.Current(ctx).User.ID)
	if err != nil {
		return err
	}
	if !p.Has(perms.ManageServer) {
		return httpx.MissingPermission()
	}
	return nil
}

// ServerImageUpload serves PUT /api/server/{icon,banner} and POST
// /api/server/images (kind "page"). It must run behind auth.RequireHTTP.
func (s *Service) ServerImageUpload(kind string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		if err := s.requireManageServer(ctx); err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		staged, err := s.stageForm(w, r, maxServerImageBytes)
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		imgID, sum, err := s.saveServerImage(ctx, kind, staged)
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		if kind == "page" {
			httpx.WriteJSON(w, http.StatusCreated, map[string]string{"id": imgID.String(), "url": "/api/server/images/" + imgID.String()})
			return
		}
		if err := s.server.PublishServerUpdate(ctx); err != nil {
			slog.WarnContext(ctx, "files: publishing server update", "err", err)
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"url": "/api/server/" + kind + "?v=" + sum[:12]})
	})
}

// stageForm reads the multipart "file" field into the store's staging area.
func (s *Service) stageForm(w http.ResponseWriter, r *http.Request, limit int64) (*Staged, error) {
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
		return staged, nil
	}
}

// saveServerImage cleans an image and records it, replacing the previous
// icon or banner.
func (s *Service) saveServerImage(ctx context.Context, kind string, staged *Staged) (id.ID, string, error) {
	defer s.store.Discard(staged)
	data, err := staged.Bytes()
	if err != nil {
		return 0, "", err
	}
	ct, ik := Sniff(data[:min(len(data), 512)])
	if ik == "" {
		return 0, "", httpx.BadRequest("NOT_AN_IMAGE", "upload a PNG, JPEG, WebP or GIF image")
	}
	clean, err := Clean(ik, data)
	if err != nil {
		return 0, "", httpx.BadRequest("NOT_AN_IMAGE", "the image could not be read")
	}
	if _, _, err := Info(clean); err != nil {
		return 0, "", httpx.BadRequest("NOT_AN_IMAGE", "the image could not be read")
	}
	cleaned, err := s.store.Stage(bytes.NewReader(clean), int64(len(clean)))
	if err != nil {
		return 0, "", err
	}
	defer s.store.Discard(cleaned)

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, "", err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('server_image:' || $1::text, 0))`, kind); err != nil {
		return 0, "", err
	}
	if err := lockBlobs(ctx, tx, cleaned.Sum); err != nil {
		return 0, "", err
	}
	if err := s.store.Commit(cleaned); err != nil {
		return 0, "", err
	}
	var old *string
	if kind != "page" {
		err := tx.QueryRow(ctx, `DELETE FROM server_images WHERE kind = $1 RETURNING sha256`, kind).Scan(&old)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return 0, "", err
		}
	}
	imgID := id.New()
	if _, err := tx.Exec(ctx, `INSERT INTO server_images (id, kind, sha256, content_type) VALUES ($1, $2, $3, $4)`,
		imgID, kind, cleaned.Sum, ct); err != nil {
		return 0, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, "", err
	}
	if old != nil && *old != cleaned.Sum {
		if err := s.removeIfUnused(ctx, *old); err != nil {
			slog.WarnContext(ctx, "files: removing the old server image; the sweep will retry", "err", err)
		}
	}
	return imgID, cleaned.Sum, nil
}

// ServerImageDelete serves DELETE /api/server/{icon,banner}. It must run
// behind auth.RequireHTTP.
func (s *Service) ServerImageDelete(kind string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		if err := s.requireManageServer(ctx); err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		var sum string
		err := s.db.QueryRow(ctx, `DELETE FROM server_images WHERE kind = $1 RETURNING sha256`, kind).Scan(&sum)
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.WriteHTTPError(w, r, httpx.NotFound(kind))
			return
		}
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		if err := s.removeIfUnused(ctx, sum); err != nil {
			slog.WarnContext(ctx, "files: removing a server image; the sweep will retry", "err", err)
		}
		if err := s.server.PublishServerUpdate(ctx); err != nil {
			slog.WarnContext(ctx, "files: publishing server update", "err", err)
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

// ServerImageDownload serves GET /api/server/icon, /api/server/banner and
// /api/server/images/{id} without a session: the sign-in page shows them.
func (s *Service) ServerImageDownload() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var sum, ct string
		var err error
		if raw := r.PathValue("id"); raw != "" {
			imgID, perr := httpx.ParseID(raw, "image")
			if perr != nil {
				httpx.WriteHTTPError(w, r, perr)
				return
			}
			err = s.db.QueryRow(ctx, `SELECT sha256, content_type FROM server_images WHERE id = $1 AND kind = 'page'`, imgID).Scan(&sum, &ct)
		} else {
			kind := "icon"
			if r.URL.Path == "/api/server/banner" {
				kind = "banner"
			}
			err = s.db.QueryRow(ctx, `SELECT sha256, content_type FROM server_images WHERE kind = $1`, kind).Scan(&sum, &ct)
		}
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.WriteHTTPError(w, r, httpx.NotFound("image"))
			return
		}
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		// Versioned and per-ID URLs never change content; bare icon/banner URLs do.
		s.ServeBlob(w, r, sum, ct, r.URL.Query().Has("v") || r.PathValue("id") != "")
	})
}
