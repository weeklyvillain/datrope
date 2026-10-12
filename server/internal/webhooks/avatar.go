package webhooks

import (
	"errors"
	"io"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/audit"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

const (
	maxAvatarBytes = 512 << 10 // as for user avatars
	maxAvatarSide  = 1024
)

// readAvatar reads and checks the multipart "file" field: size, image type and dimensions.
func (s *Service) readAvatar(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	tooLarge := httpx.E(http.StatusRequestEntityTooLarge, "TOO_LARGE", "avatars can be at most 512 KB")
	limit := int64(maxAvatarBytes) + 64<<10
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	if err := r.ParseMultipartForm(limit); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return nil, tooLarge
		}
		return nil, httpx.BadRequest("VALIDATION_FAILED", "expected a multipart/form-data body")
	}
	defer func() { _ = r.MultipartForm.RemoveAll() }()
	f, _, err := r.FormFile("file")
	if err != nil {
		return nil, httpx.BadRequest("MISSING_FILE", `the form has no "file" field`)
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxAvatarBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxAvatarBytes {
		return nil, tooLarge
	}
	width, height, err := s.blobs.ImageSize(data)
	if err != nil {
		return nil, httpx.BadRequest("NOT_AN_IMAGE", "upload a PNG, JPEG, WebP or GIF image")
	}
	if width > maxAvatarSide || height > maxAvatarSide {
		return nil, httpx.BadRequest("IMAGE_TOO_BIG", "avatars can be at most 1024 × 1024 pixels")
	}
	return data, nil
}

func writeWebhook(w http.ResponseWriter, r *http.Request, hook *Webhook, err error) {
	if err != nil {
		httpx.WriteHTTPError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, hook)
}

// AvatarUploadHandler serves PUT /api/webhooks/{id}/avatar (multipart
// "file"). It must run behind auth.RequireHTTP.
func (s *Service) AvatarUploadHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hook, err := s.uploadAvatar(w, r)
		writeWebhook(w, r, hook, err)
	})
}

func (s *Service) uploadAvatar(w http.ResponseWriter, r *http.Request) (*Webhook, error) {
	ctx := r.Context()
	hook, err := s.manageable(ctx, r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	data, err := s.readAvatar(w, r)
	if err != nil {
		return nil, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var old *string
	if err := tx.QueryRow(ctx, `SELECT avatar_sha256 FROM webhooks WHERE id = $1 FOR UPDATE`, hook.ID).Scan(&old); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, httpx.NotFound("webhook")
		}
		return nil, err
	}
	sum, ct, err := s.blobs.StoreImageBlob(ctx, tx, data) // sniffs the type and strips metadata
	if err != nil {
		return nil, err
	}
	updated, err := scanWebhook(tx.QueryRow(ctx,
		`UPDATE webhooks SET avatar_sha256 = $2, avatar_content_type = $3 WHERE id = $1 RETURNING `+webhookCols, hook.ID, sum, ct))
	if err != nil {
		return nil, err
	}
	if old == nil || *old != sum {
		if err := s.record(ctx, tx, audit.WebhookUpdate, updated, []audit.LogChange{{Field: "avatar"}}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if old != nil && *old != sum {
		s.removeBlob(ctx, *old)
	}
	return updated, nil
}

// AvatarDeleteHandler serves DELETE /api/webhooks/{id}/avatar. It must run
// behind auth.RequireHTTP.
func (s *Service) AvatarDeleteHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hook, err := s.clearAvatar(r)
		writeWebhook(w, r, hook, err)
	})
}

func (s *Service) clearAvatar(r *http.Request) (*Webhook, error) {
	ctx := r.Context()
	hook, err := s.manageable(ctx, r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var old *string
	if err := tx.QueryRow(ctx, `SELECT avatar_sha256 FROM webhooks WHERE id = $1 FOR UPDATE`, hook.ID).Scan(&old); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, httpx.NotFound("webhook")
		}
		return nil, err
	}
	updated, err := scanWebhook(tx.QueryRow(ctx,
		`UPDATE webhooks SET avatar_sha256 = NULL, avatar_content_type = NULL WHERE id = $1 RETURNING `+webhookCols, hook.ID))
	if err != nil {
		return nil, err
	}
	if old != nil {
		if err := s.record(ctx, tx, audit.WebhookUpdate, updated, []audit.LogChange{{Field: "avatar"}}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if old != nil {
		s.removeBlob(ctx, *old)
	}
	return updated, nil
}

// AvatarHandler serves GET /api/webhooks/{id}/avatar to anyone who can see
// the webhook's channel. It must run behind auth.RequireHTTP.
func (s *Service) AvatarHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := s.serveAvatar(w, r); err != nil {
			httpx.WriteHTTPError(w, r, err)
		}
	})
}

func (s *Service) serveAvatar(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	wid, err := httpx.ParseID(r.PathValue("id"), "avatar")
	if err != nil {
		return err
	}
	var channelID id.ID
	var sum, ct string
	err = s.db.QueryRow(ctx, `
		SELECT channel_id, avatar_sha256, avatar_content_type FROM webhooks WHERE id = $1 AND avatar_sha256 IS NOT NULL`,
		wid).Scan(&channelID, &sum, &ct)
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.NotFound("avatar")
	}
	if err != nil {
		return err
	}
	if _, _, err := s.channels.Access(ctx, auth.Current(ctx).User.ID, channelID, perms.ViewChannel); err != nil {
		var he *httpx.Error
		if errors.As(err, &he) {
			return httpx.NotFound("avatar") // do not reveal webhooks of channels you cannot see
		}
		return err
	}
	s.blobs.ServePrivateBlob(w, r, sum, ct)
	return nil
}
