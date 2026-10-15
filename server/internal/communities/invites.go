package communities

import (
	"context"
	"crypto/rand"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type Invite struct {
	Code      string     `json:"code"`
	CreatorID id.ID      `json:"creator_id"`
	MaxUses   *int       `json:"max_uses,omitempty"`
	Uses      int        `json:"uses"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
	// GuestTTLSeconds is set on guest links.
	GuestTTLSeconds *int `json:"guest_ttl_seconds,omitempty" doc:"Set on guest links: how long each guest stays"`
}

type InvitePreview struct {
	Code        string `json:"code"`
	ServerName  string `json:"server_name"`
	MemberCount int    `json:"member_count"`
	// GuestTTLSeconds is set on guest links.
	GuestTTLSeconds *int `json:"guest_ttl_seconds,omitempty" doc:"Set on guest links: how long each guest stays"`
}

// ServerPreview is what anyone may see before signing in: the sign-in,
// registration and invite pages show it.
type ServerPreview struct {
	Name        string    `json:"name"`
	Description string    `json:"description"`
	AccentColor string    `json:"accent_color" pattern:"^#[0-9a-f]{6}$"`
	IconURL     *string   `json:"icon_url,omitempty"`
	BannerURL   *string   `json:"banner_url,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	MemberCount int       `json:"member_count"`
	OnlineCount int       `json:"online_count" doc:"Members who are online or idle"`
}

func (s *Service) serverPreview(ctx context.Context) (*ServerPreview, error) {
	sv, err := s.Server(ctx)
	if errors.Is(err, ErrNotFound) {
		return nil, httpx.NotFound("server")
	}
	if err != nil {
		return nil, err
	}
	ids, err := s.MemberIDs(ctx, sv.ID)
	if err != nil {
		return nil, err
	}
	p := ServerPreview{Name: sv.Name, Description: sv.Description, AccentColor: sv.AccentColor, IconURL: sv.IconURL,
		BannerURL: sv.BannerURL, CreatedAt: sv.CreatedAt, MemberCount: len(ids)}
	if s.presence != nil {
		for _, uid := range ids {
			if st := s.presence.StatusOf(uid); st == "online" || st == "idle" {
				p.OnlineCount++
			}
		}
	}
	return &p, nil
}

const inviteUsable = `(max_uses IS NULL OR uses < max_uses) AND (expires_at IS NULL OR expires_at > now())`

const inviteCols = `code, creator_id, max_uses, uses, expires_at, created_at, guest_ttl_seconds`

func scanInvite(row pgx.Row) (*Invite, error) {
	var i Invite
	err := row.Scan(&i.Code, &i.CreatorID, &i.MaxUses, &i.Uses, &i.ExpiresAt, &i.CreatedAt, &i.GuestTTLSeconds)
	return &i, err
}

func errInviteInvalid() *httpx.Error {
	return httpx.E(http.StatusNotFound, "INVITE_INVALID", "this invite is invalid or has expired")
}

func (s *Service) createInvite(ctx context.Context, serverID, creatorID id.ID, maxUses, expiresIn, guestTTL *int) (*Invite, error) {
	inv := Invite{Code: rand.Text()[:10], CreatorID: creatorID, MaxUses: maxUses, GuestTTLSeconds: guestTTL}
	if expiresIn != nil {
		t := time.Now().Add(time.Duration(*expiresIn) * time.Second)
		inv.ExpiresAt = &t
	}
	err := s.db.QueryRow(ctx, `
		INSERT INTO invites (code, community_id, creator_id, max_uses, expires_at, guest_ttl_seconds) VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING created_at`, inv.Code, serverID, inv.CreatorID, inv.MaxUses, inv.ExpiresAt, inv.GuestTTLSeconds).Scan(&inv.CreatedAt)
	return &inv, err
}

func (s *Service) listInvites(ctx context.Context, serverID id.ID) ([]Invite, error) {
	rows, err := s.db.Query(ctx, `
		SELECT `+inviteCols+` FROM invites
		WHERE community_id = $1 AND `+inviteUsable+` ORDER BY created_at`, serverID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Invite{}
	for rows.Next() {
		i, err := scanInvite(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *i)
	}
	return out, rows.Err()
}

func (s *Service) invite(ctx context.Context, code string) (*Invite, error) {
	i, err := scanInvite(s.db.QueryRow(ctx, `
		SELECT `+inviteCols+` FROM invites
		WHERE code = $1 AND `+inviteUsable, code))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errInviteInvalid()
	}
	return i, err
}

func (s *Service) preview(ctx context.Context, code string) (*InvitePreview, error) {
	var p InvitePreview
	err := s.db.QueryRow(ctx, `
		SELECT i.code, c.name, (SELECT count(*) FROM members m WHERE m.community_id = c.id), i.guest_ttl_seconds
		FROM invites i JOIN communities c ON c.id = i.community_id
		WHERE i.code = $1 AND `+inviteUsable, code).Scan(&p.Code, &p.ServerName, &p.MemberCount, &p.GuestTTLSeconds)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errInviteInvalid()
	}
	return &p, err
}

// Check implements auth.Joiner. A guest link cannot register a full account.
func (s *Service) Check(ctx context.Context, code string) error {
	inv, err := s.invite(ctx, code)
	if err != nil {
		return err
	}
	if inv.GuestTTLSeconds != nil {
		return httpx.BadRequest("GUEST_INVITE", "this is a guest link; join as a guest instead")
	}
	return nil
}

// join adds userID to the server with an invite. Joining when you are
// already a member succeeds without using up the invite.
func (s *Service) join(ctx context.Context, code string, userID id.ID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var serverID id.ID
	err = tx.QueryRow(ctx, `SELECT community_id FROM invites WHERE code = $1 AND `+inviteUsable+` FOR UPDATE`, code).
		Scan(&serverID)
	if errors.Is(err, pgx.ErrNoRows) {
		return errInviteInvalid()
	}
	if err != nil {
		return err
	}
	var banned, member bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM bans WHERE community_id = $1 AND user_id = $2),
		       EXISTS (SELECT 1 FROM members WHERE community_id = $1 AND user_id = $2)`,
		serverID, userID).Scan(&banned, &member); err != nil {
		return err
	}
	if banned {
		return httpx.E(http.StatusForbidden, "BANNED", "you are banned from this server")
	}
	if !member {
		if _, err := tx.Exec(ctx, `UPDATE invites SET uses = uses + 1 WHERE code = $1`, code); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO members (community_id, user_id, accepted_rules_at) VALUES ($1, $2, `+acceptedOnJoin+`)`, serverID, userID); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if member {
		return nil
	}
	return s.publishMemberAdd(ctx, serverID, userID)
}

func (s *Service) deleteInvite(ctx context.Context, code string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM invites WHERE code = $1`, code)
	return err
}

func errNotGuestInvite() *httpx.Error {
	return httpx.E(http.StatusNotFound, "NOT_GUEST_INVITE", "this invite is not a guest link")
}

// GuestTTL implements auth.Joiner.
func (s *Service) GuestTTL(ctx context.Context, code string) (time.Duration, error) {
	inv, err := s.invite(ctx, code)
	if err != nil {
		return 0, err
	}
	if inv.GuestTTLSeconds == nil {
		return 0, errNotGuestInvite()
	}
	return time.Duration(*inv.GuestTTLSeconds) * time.Second, nil
}

// JoinGuest implements auth.Joiner: the new guest becomes a member holding
// the Guest role, which is created on first use just above @everyone.
func (s *Service) JoinGuest(ctx context.Context, code string, userID id.ID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var serverID id.ID
	var ttl *int
	err = tx.QueryRow(ctx, `SELECT community_id, guest_ttl_seconds FROM invites WHERE code = $1 AND `+inviteUsable+` FOR UPDATE`, code).
		Scan(&serverID, &ttl)
	if errors.Is(err, pgx.ErrNoRows) {
		return errInviteInvalid()
	}
	if err != nil {
		return err
	}
	if ttl == nil {
		return errNotGuestInvite()
	}
	role, created, err := ensureGuestRole(ctx, tx, serverID)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE invites SET uses = uses + 1 WHERE code = $1`, code); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO members (community_id, user_id, accepted_rules_at) VALUES ($1, $2, `+acceptedOnJoin+`)`, serverID, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO member_roles (community_id, user_id, role_id) VALUES ($1, $2, $3)`, serverID, userID, role.ID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	// The guest has joined. Errors from here on are only logged: returning one
	// would make the caller delete an account that is already a member.
	if created {
		s.bus.Publish(events.Event{Type: "ROLE_CREATE", Data: role, Scope: events.Scope{CommunityID: serverID}})
		if err := s.publishMoved(ctx, serverID, 2, ownerRank, role.ID); err != nil {
			slog.ErrorContext(ctx, "announcing roles moved by the Guest role", "err", err)
		}
	}
	if err := s.publishMemberAdd(ctx, serverID, userID); err != nil {
		slog.ErrorContext(ctx, "announcing a new guest", "user_id", userID, "err", err)
	}
	return nil
}

// ensureGuestRole returns the Guest role, creating it at position 1 (the
// other roles move up one) if the server has none yet.
func ensureGuestRole(ctx context.Context, tx pgx.Tx, serverID id.ID) (*Role, bool, error) {
	if err := lockRoles(ctx, tx, serverID); err != nil {
		return nil, false, err
	}
	r, err := scanRole(tx.QueryRow(ctx, `SELECT `+roleCols+` FROM roles WHERE community_id = $1 AND is_guest`, serverID))
	if err == nil {
		return r, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE roles SET position = position + 1 WHERE community_id = $1 AND position >= 1`, serverID); err != nil {
		return nil, false, err
	}
	r, err = scanRole(tx.QueryRow(ctx, `
		INSERT INTO roles (id, community_id, name, permissions, position, is_guest)
		VALUES ($1, $2, 'Guest', $3, 1, TRUE) RETURNING `+roleCols,
		id.New(), serverID, int64(perms.GuestDefault)))
	return r, true, err
}
