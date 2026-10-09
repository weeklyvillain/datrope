package communities

import (
	"context"
	"crypto/rand"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

type Invite struct {
	Code      string     `json:"code"`
	CreatorID id.ID      `json:"creator_id"`
	MaxUses   *int       `json:"max_uses,omitempty"`
	Uses      int        `json:"uses"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
}

type InvitePreview struct {
	Code        string `json:"code"`
	ServerName  string `json:"server_name"`
	MemberCount int    `json:"member_count"`
}

const inviteUsable = `(max_uses IS NULL OR uses < max_uses) AND (expires_at IS NULL OR expires_at > now())`

func errInviteInvalid() *httpx.Error {
	return httpx.E(http.StatusNotFound, "INVITE_INVALID", "this invite is invalid or has expired")
}

func (s *Service) createInvite(ctx context.Context, serverID, creatorID id.ID, maxUses, expiresIn *int) (*Invite, error) {
	inv := Invite{Code: rand.Text()[:10], CreatorID: creatorID, MaxUses: maxUses}
	if expiresIn != nil {
		t := time.Now().Add(time.Duration(*expiresIn) * time.Second)
		inv.ExpiresAt = &t
	}
	err := s.db.QueryRow(ctx, `
		INSERT INTO invites (code, community_id, creator_id, max_uses, expires_at) VALUES ($1, $2, $3, $4, $5)
		RETURNING created_at`, inv.Code, serverID, inv.CreatorID, inv.MaxUses, inv.ExpiresAt).Scan(&inv.CreatedAt)
	return &inv, err
}

func (s *Service) listInvites(ctx context.Context, serverID id.ID) ([]Invite, error) {
	rows, err := s.db.Query(ctx, `
		SELECT code, creator_id, max_uses, uses, expires_at, created_at FROM invites
		WHERE community_id = $1 AND `+inviteUsable+` ORDER BY created_at`, serverID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Invite{}
	for rows.Next() {
		var i Invite
		if err := rows.Scan(&i.Code, &i.CreatorID, &i.MaxUses, &i.Uses, &i.ExpiresAt, &i.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

func (s *Service) invite(ctx context.Context, code string) (*Invite, error) {
	var i Invite
	err := s.db.QueryRow(ctx, `
		SELECT code, creator_id, max_uses, uses, expires_at, created_at FROM invites
		WHERE code = $1 AND `+inviteUsable, code).
		Scan(&i.Code, &i.CreatorID, &i.MaxUses, &i.Uses, &i.ExpiresAt, &i.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errInviteInvalid()
	}
	return &i, err
}

func (s *Service) preview(ctx context.Context, code string) (*InvitePreview, error) {
	var p InvitePreview
	err := s.db.QueryRow(ctx, `
		SELECT i.code, c.name, (SELECT count(*) FROM members m WHERE m.community_id = c.id)
		FROM invites i JOIN communities c ON c.id = i.community_id
		WHERE i.code = $1 AND `+inviteUsable, code).Scan(&p.Code, &p.ServerName, &p.MemberCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errInviteInvalid()
	}
	return &p, err
}

// Check implements auth.Joiner.
func (s *Service) Check(ctx context.Context, code string) error {
	_, err := s.invite(ctx, code)
	return err
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
