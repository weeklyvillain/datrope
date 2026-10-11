package communities

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

// RoleColors are the colours a role may have.
var RoleColors = []string{"#e74c3c", "#f5a524", "#2ecc71", "#2dd4bf", "#4aa3ff", "#a78bfa", "#fb7185", "#969da2"}

// ownerRank is above any role position.
const ownerRank = 1 << 30

// rank is the highest position among userID's roles that carry authority
// (ownerRank for the owner, -1 for non-members). Self-assignable roles grant
// none: anyone can take them, so they must not shield a member from moderation.
// tx may be nil.
func (s *Service) rank(ctx context.Context, tx pgx.Tx, serverID, userID id.ID) (int, error) {
	var r int
	q := `
		SELECT CASE WHEN c.owner_id = $2 THEN $3
		            ELSE COALESCE((SELECT max(ro.position) FROM member_roles mr JOIN roles ro ON ro.id = mr.role_id AND NOT ro.self_assignable
		                           WHERE mr.community_id = $1 AND mr.user_id = $2), 0) END
		FROM communities c JOIN members m ON m.community_id = c.id AND m.user_id = $2
		WHERE c.id = $1`
	var row pgx.Row
	if tx != nil {
		row = tx.QueryRow(ctx, q, serverID, userID, ownerRank)
	} else {
		row = s.db.QueryRow(ctx, q, serverID, userID, ownerRank)
	}
	err := row.Scan(&r)
	if errors.Is(err, pgx.ErrNoRows) {
		return -1, nil
	}
	return r, err
}

// Outranks reports whether actorID may moderate targetID (spec §2: role hierarchy).
func (s *Service) Outranks(ctx context.Context, actorID, targetID id.ID) (bool, error) {
	sid, err := s.ServerID(ctx)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	a, err := s.rank(ctx, nil, sid, actorID)
	if err != nil {
		return false, err
	}
	t, err := s.rank(ctx, nil, sid, targetID)
	if err != nil {
		return false, err
	}
	return a >= 0 && a > t, nil
}

// canModerate refuses unless the actor outranks the target.
func (s *Service) canModerate(ctx context.Context, a actor, target id.ID) error {
	ok, err := s.Outranks(ctx, a.Member.UserID, target)
	if err != nil {
		return err
	}
	if !ok {
		return httpx.MissingPermission()
	}
	return nil
}

// canEditRole refuses unless the role is below rank, the actor's highest role.
func canEditRole(rank int, r *Role) error {
	if r.Position >= rank {
		return httpx.MissingPermission()
	}
	return nil
}

// lockRoles serialises changes to role order and role holdings: every such
// transaction locks the server row first. Concurrent moves then cannot leave
// duplicate positions, and hierarchy checks see ranks nobody is changing.
func lockRoles(ctx context.Context, tx pgx.Tx, serverID id.ID) error {
	_, err := tx.Exec(ctx, `SELECT 1 FROM communities WHERE id = $1 FOR UPDATE`, serverID)
	return err
}

// lockedRole takes the role-order lock and reads the role inside tx.
func lockedRole(ctx context.Context, tx pgx.Tx, serverID id.ID, rawRoleID string) (*Role, error) {
	rid, err := httpx.ParseID(rawRoleID, "role")
	if err != nil {
		return nil, err
	}
	if err := lockRoles(ctx, tx, serverID); err != nil {
		return nil, err
	}
	r, err := scanRole(tx.QueryRow(ctx, `SELECT `+roleCols+` FROM roles WHERE id = $1 AND community_id = $2`, rid, serverID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound("role")
	}
	return r, err
}

// moveRole puts role r at position pos (≥ 1), shifting the roles in between
// so positions stay unique.
func moveRole(ctx context.Context, tx pgx.Tx, serverID id.ID, r *Role, pos int) error {
	var top int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(max(position), 0) FROM roles WHERE community_id = $1`, serverID).Scan(&top); err != nil {
		return err
	}
	pos = min(pos, top)
	if pos == r.Position {
		return nil
	}
	if pos > r.Position {
		_, err := tx.Exec(ctx, `UPDATE roles SET position = position - 1 WHERE community_id = $1 AND position > $2 AND position <= $3`,
			serverID, r.Position, pos)
		if err != nil {
			return err
		}
	} else {
		_, err := tx.Exec(ctx, `UPDATE roles SET position = position + 1 WHERE community_id = $1 AND position >= $2 AND position < $3`,
			serverID, pos, r.Position)
		if err != nil {
			return err
		}
	}
	_, err := tx.Exec(ctx, `UPDATE roles SET position = $2 WHERE id = $1`, r.ID, pos)
	return err
}
