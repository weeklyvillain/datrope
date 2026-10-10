package communities

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// IconBlobs is what role icons need from files: cleaned, stored images.
type IconBlobs interface {
	StoreImageBlob(ctx context.Context, tx pgx.Tx, data []byte) (sum, contentType string, err error)
	ImageSize(data []byte) (width, height int, err error)
	RemoveBlobs(ctx context.Context, sums []string) error
	ServeBlob(w http.ResponseWriter, r *http.Request, sum, contentType string, immutable bool)
}

func (s *Service) SetIconBlobs(b IconBlobs) { s.blobs = b }

const (
	maxRoleIconBytes = 256 << 10
	maxRoleIconSide  = 512
)

// checkIconEmoji accepts "" (no icon), custom:<id> of an existing custom
// emoji, or a short Unicode emoji: no letters, digits or spaces.
func (s *Service) checkIconEmoji(ctx context.Context, tx pgx.Tx, v string) error {
	bad := httpx.BadRequest("BAD_ICON", "use one emoji")
	if v == "" {
		return nil
	}
	if raw, ok := strings.CutPrefix(v, "custom:"); ok {
		eid, err := id.Parse(raw)
		if err != nil {
			return bad
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM emoji WHERE id = $1)`, eid).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return httpx.NotFound("emoji")
		}
		return nil
	}
	if utf8.RuneCountInString(v) > 12 {
		return bad
	}
	for _, r := range v {
		if r < 0x80 && !strings.ContainsRune("#*0123456789", r) || unicode.IsSpace(r) || unicode.IsLetter(r) || unicode.IsControl(r) {
			return bad
		}
	}
	return nil
}

func (s *Service) removeIconBlob(ctx context.Context, sum string) {
	if s.blobs == nil {
		return
	}
	if err := s.blobs.RemoveBlobs(ctx, []string{sum}); err != nil {
		slog.WarnContext(ctx, "communities: removing a role icon; the sweep will retry", "err", err)
	}
}

// RoleIconUploadHandler serves PUT /api/server/roles/{roleID}/icon (multipart
// "file"), which replaces any emoji icon; it must run behind RequireHTTP.
func (s *Service) RoleIconUploadHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		data, err := readIcon(w, r, s.blobs)
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		role, err := s.setRoleIcon(ctx, r.PathValue("roleID"), data)
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		httpx.WriteJSON(w, http.StatusOK, role)
	})
}

// RoleIconDeleteHandler serves DELETE /api/server/roles/{roleID}/icon: it
// removes the icon, emoji or image; it must run behind RequireHTTP.
func (s *Service) RoleIconDeleteHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		role, err := s.setRoleIcon(r.Context(), r.PathValue("roleID"), nil)
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		httpx.WriteJSON(w, http.StatusOK, role)
	})
}

// RoleIconHandler serves the public GET /api/role-icons/{roleID}.
func (s *Service) RoleIconHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rid, err := httpx.ParseID(r.PathValue("roleID"), "role")
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		var sum, ct string
		err = s.db.QueryRow(r.Context(), `SELECT icon_sha256, icon_content_type FROM roles WHERE id = $1 AND icon_sha256 IS NOT NULL`, rid).Scan(&sum, &ct)
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.WriteHTTPError(w, r, httpx.NotFound("role icon"))
			return
		}
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		s.blobs.ServeBlob(w, r, sum, ct, len(sum) >= 12 && r.URL.Query().Get("v") == sum[:12])
	})
}

func readIcon(w http.ResponseWriter, r *http.Request, blobs IconBlobs) ([]byte, error) {
	tooLarge := httpx.E(http.StatusRequestEntityTooLarge, "TOO_LARGE", "role icons can be at most 256 KB")
	limit := int64(maxRoleIconBytes) + 64<<10
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
	data, err := io.ReadAll(io.LimitReader(f, maxRoleIconBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxRoleIconBytes {
		return nil, tooLarge
	}
	width, height, err := blobs.ImageSize(data)
	if err != nil {
		return nil, httpx.BadRequest("NOT_AN_IMAGE", "upload a PNG, JPEG, WebP or GIF image")
	}
	if width > maxRoleIconSide || height > maxRoleIconSide {
		return nil, httpx.BadRequest("IMAGE_TOO_BIG", "role icons can be at most 512 × 512 pixels")
	}
	return data, nil
}

// setRoleIcon stores data as the role's icon, or removes the icon when data
// is nil. Like any role edit it needs MANAGE_ROLES and a role below one's own.
func (s *Service) setRoleIcon(ctx context.Context, rawRoleID string, data []byte) (*Role, error) {
	a, err := s.requireActor(ctx, perms.ManageRoles)
	if err != nil {
		return nil, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	role, err := lockedRole(ctx, tx, a.CommunityID, rawRoleID)
	if err != nil {
		return nil, err
	}
	if role.ID == a.CommunityID {
		return nil, httpx.BadRequest("CANNOT_STYLE_EVERYONE", "the @everyone role has no icon")
	}
	rank, err := s.rank(ctx, tx, a.CommunityID, a.Member.UserID)
	if err != nil {
		return nil, err
	}
	if err := canEditRole(rank, role); err != nil {
		return nil, err
	}
	var old *string
	if err := tx.QueryRow(ctx, `SELECT icon_sha256 FROM roles WHERE id = $1`, role.ID).Scan(&old); err != nil {
		return nil, err
	}
	var sum, ct *string
	if data != nil {
		su, c, err := s.blobs.StoreImageBlob(ctx, tx, data) // sniffs the type and strips metadata
		if err != nil {
			return nil, err
		}
		sum, ct = &su, &c
	}
	updated, err := scanRole(tx.QueryRow(ctx, `
		UPDATE roles SET icon_emoji = '', icon_sha256 = $2, icon_content_type = $3 WHERE id = $1 RETURNING `+roleCols, role.ID, sum, ct))
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if old != nil && (sum == nil || *old != *sum) {
		s.removeIconBlob(ctx, *old)
	}
	s.bus.Publish(events.Event{Type: "ROLE_UPDATE", Data: updated, Scope: events.Scope{CommunityID: a.CommunityID}})
	return updated, nil
}
