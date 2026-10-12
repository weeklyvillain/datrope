package communities

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/audit"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type CreateRoleRequest struct {
	Name        string      `json:"name" minLength:"1" maxLength:"32"`
	Permissions perms.Perms `json:"permissions"`
	Color       *string     `json:"color,omitempty" enum:"#e74c3c,#f5a524,#2ecc71,#2dd4bf,#4aa3ff,#a78bfa,#fb7185,#969da2"`
	Hoist       bool        `json:"hoist,omitempty" doc:"Show members with this role separately in the member list"`

	SelfAssignable bool   `json:"self_assignable,omitempty"`
	Mentionable    bool   `json:"mentionable,omitempty"`
	Description    string `json:"description,omitempty" maxLength:"120"`
}

type UpdateRoleRequest struct {
	Name        *string      `json:"name,omitempty" minLength:"1" maxLength:"32"`
	Permissions *perms.Perms `json:"permissions,omitempty"`
	Position    *int         `json:"position,omitempty" minimum:"1" doc:"Higher is more senior; @everyone is always 0"`
	Color       *string      `json:"color,omitempty" enum:"#e74c3c,#f5a524,#2ecc71,#2dd4bf,#4aa3ff,#a78bfa,#fb7185,#969da2"`
	ClearColor  bool         `json:"clear_color,omitempty" doc:"Remove the role's colour (ignored when color is set)"`
	Hoist       *bool        `json:"hoist,omitempty"`
	IconEmoji   *string      `json:"icon_emoji,omitempty" maxLength:"64" doc:"A Unicode emoji or custom:<emoji id>; replaces an uploaded icon. Empty removes the icon"`

	SelfAssignable *bool   `json:"self_assignable,omitempty"`
	Mentionable    *bool   `json:"mentionable,omitempty"`
	Description    *string `json:"description,omitempty" maxLength:"120"`
}

type BanRequest struct {
	Reason string `json:"reason,omitempty" maxLength:"512"`
}

type Ban struct {
	User      auth.PublicUser `json:"user"`
	Reason    string          `json:"reason"`
	CreatedAt time.Time       `json:"created_at"`
}

type RoleDeleted struct {
	ID id.ID `json:"id"`
}

type rolePath struct {
	RoleID string `path:"roleID"`
}

type memberRolePath struct {
	UserID string `path:"userID"`
	RoleID string `path:"roleID"`
}

// canTouch enforces "you can only hand out permissions you have".
func canTouch(a actor, ps ...perms.Perms) error {
	for _, p := range ps {
		if !a.Base.Has(p) {
			return httpx.MissingPermission()
		}
	}
	return nil
}

// checkSelfAssign: a role members give themselves grants no power and is never the Guest role.
func checkSelfAssign(guest, selfAssignable bool, p perms.Perms) error {
	if !selfAssignable {
		return nil
	}
	if guest {
		return httpx.BadRequest("CANNOT_SELF_ASSIGN", "the Guest role cannot be self-assignable")
	}
	if !perms.SelfAssignSafe(p) {
		return httpx.BadRequest("SELF_ASSIGN_POWER", "a self-assignable role cannot grant moderation, admin or mention permissions")
	}
	return nil
}

// publishMoved sends ROLE_UPDATE for the roles now at positions lo..hi
// (their positions changed), except skip.
func (s *Service) publishMoved(ctx context.Context, communityID id.ID, lo, hi int, skip id.ID) error {
	rows, err := s.db.Query(ctx, `SELECT `+roleCols+` FROM roles
		WHERE community_id = $1 AND position BETWEEN $2 AND $3 AND id <> $4`, communityID, lo, hi, skip)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		r, err := scanRole(rows)
		if err != nil {
			return err
		}
		s.bus.Publish(events.Event{Type: "ROLE_UPDATE", Data: r, Scope: events.Scope{CommunityID: communityID}})
	}
	return rows.Err()
}

func (s *Service) publishMemberUpdate(ctx context.Context, communityID, userID id.ID) error {
	m, err := s.member(ctx, communityID, userID)
	if err != nil {
		return err
	}
	s.bus.Publish(events.Event{Type: "MEMBER_UPDATE", Data: m, Scope: events.Scope{CommunityID: communityID}})
	return nil
}

// roleChanges lists what an update changed, for the audit log. Permissions
// are decimal masks; the client names the flags.
func roleChanges(old, new *Role) []audit.LogChange {
	color := func(c *string) string {
		if c == nil {
			return ""
		}
		return *c
	}
	cs := audit.Diff(nil, "name", old.Name, new.Name)
	cs = audit.Diff(cs, "permissions", strconv.FormatUint(uint64(old.Permissions), 10), strconv.FormatUint(uint64(new.Permissions), 10))
	cs = audit.Diff(cs, "position", strconv.Itoa(old.Position), strconv.Itoa(new.Position))
	cs = audit.Diff(cs, "color", color(old.Color), color(new.Color))
	cs = audit.Diff(cs, "hoist", strconv.FormatBool(old.Hoist), strconv.FormatBool(new.Hoist))
	cs = audit.Diff(cs, "icon", old.IconEmoji+old.IconURL, new.IconEmoji+new.IconURL)
	cs = audit.Diff(cs, "self_assignable", strconv.FormatBool(old.SelfAssignable), strconv.FormatBool(new.SelfAssignable))
	cs = audit.Diff(cs, "mentionable", strconv.FormatBool(old.Mentionable), strconv.FormatBool(new.Mentionable))
	return audit.Diff(cs, "description", old.Description, new.Description)
}

func registerRoles(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	huma.Register(api, op("create-role", http.MethodPost, "/api/server/roles", http.StatusCreated),
		func(ctx context.Context, in *struct{ Body CreateRoleRequest }) (*struct{ Body *Role }, error) {
			a, err := s.requireActor(ctx, perms.ManageRoles)
			if err != nil {
				return nil, err
			}
			if err := canTouch(a, in.Body.Permissions); err != nil {
				return nil, err
			}
			if err := checkSelfAssign(false, in.Body.SelfAssignable, in.Body.Permissions); err != nil {
				return nil, err
			}
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback(ctx)
			if err := lockRoles(ctx, tx, a.CommunityID); err != nil {
				return nil, err
			}
			rank, err := s.rank(ctx, tx, a.CommunityID, a.Member.UserID)
			if err != nil {
				return nil, err
			}
			pos := rank // directly below the actor's highest role
			if rank == ownerRank {
				if err := tx.QueryRow(ctx, `SELECT COALESCE(max(position), 0) + 1 FROM roles WHERE community_id = $1`, a.CommunityID).Scan(&pos); err != nil {
					return nil, err
				}
			} else if rank < 1 {
				return nil, httpx.MissingPermission() // nothing fits below @everyone
			} else if _, err := tx.Exec(ctx, `UPDATE roles SET position = position + 1 WHERE community_id = $1 AND position >= $2`,
				a.CommunityID, pos); err != nil {
				return nil, err
			}
			r, err := scanRole(tx.QueryRow(ctx, `
				INSERT INTO roles (id, community_id, name, permissions, position, color, hoist, self_assignable, mentionable, description)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
				RETURNING `+roleCols,
				id.New(), a.CommunityID, strings.TrimSpace(in.Body.Name), int64(in.Body.Permissions), pos, in.Body.Color, in.Body.Hoist,
				in.Body.SelfAssignable, in.Body.Mentionable, strings.TrimSpace(in.Body.Description)))
			if err != nil {
				return nil, err
			}
			if err := audit.Record(ctx, tx, audit.RoleCreate, r.ID, audit.LogDetails{Name: r.Name}); err != nil {
				return nil, err
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			s.bus.Publish(events.Event{Type: "ROLE_CREATE", Data: r, Scope: events.Scope{CommunityID: a.CommunityID}})
			if rank != ownerRank {
				if err := s.publishMoved(ctx, a.CommunityID, pos+1, ownerRank, r.ID); err != nil {
					return nil, err
				}
			}
			return &struct{ Body *Role }{r}, nil
		})

	huma.Register(api, op("update-role", http.MethodPatch, "/api/server/roles/{roleID}", 0),
		func(ctx context.Context, in *struct {
			RoleID string `path:"roleID"`
			Body   UpdateRoleRequest
		}) (*struct{ Body *Role }, error) {
			a, err := s.requireActor(ctx, perms.ManageRoles)
			if err != nil {
				return nil, err
			}
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback(ctx)
			r, err := lockedRole(ctx, tx, a.CommunityID, in.RoleID)
			if err != nil {
				return nil, err
			}
			rank, err := s.rank(ctx, tx, a.CommunityID, a.Member.UserID)
			if err != nil {
				return nil, err
			}
			b := in.Body
			if r.ID == a.CommunityID {
				switch {
				case b.Name != nil:
					return nil, httpx.BadRequest("CANNOT_RENAME_EVERYONE", "the @everyone role cannot be renamed")
				case b.Position != nil:
					return nil, httpx.BadRequest("CANNOT_MOVE_EVERYONE", "the @everyone role is always at the bottom")
				case b.Color != nil || b.ClearColor || b.Hoist != nil || b.IconEmoji != nil ||
					b.SelfAssignable != nil || b.Mentionable != nil || b.Description != nil:
					return nil, httpx.BadRequest("CANNOT_STYLE_EVERYONE", "the @everyone role has no colour and is not shown separately")
				}
			} else if err := canEditRole(rank, r); err != nil {
				return nil, err
			}
			if b.Position != nil && rank != ownerRank && *b.Position >= rank {
				return nil, httpx.MissingPermission()
			}
			var newPerms *int64
			check := []perms.Perms{r.Permissions}
			if in.Body.Permissions != nil {
				p := int64(*in.Body.Permissions)
				newPerms = &p
				check = append(check, *in.Body.Permissions)
			}
			if err := canTouch(a, check...); err != nil {
				return nil, err
			}
			sa, final := r.SelfAssignable, r.Permissions
			if b.SelfAssignable != nil {
				sa = *b.SelfAssignable
			}
			if b.Permissions != nil {
				final = *b.Permissions
			}
			if err := checkSelfAssign(r.IsGuest, sa, final); err != nil {
				return nil, err
			}
			var desc *string
			if b.Description != nil {
				d := strings.TrimSpace(*b.Description)
				desc = &d
			}
			if b.Position != nil {
				if err := moveRole(ctx, tx, a.CommunityID, r, *b.Position); err != nil {
					return nil, err
				}
			}
			var oldIcon *string // an uploaded icon an emoji replaces
			if b.IconEmoji != nil {
				if err := s.checkIconEmoji(ctx, tx, *b.IconEmoji); err != nil {
					return nil, err
				}
				if err := tx.QueryRow(ctx, `SELECT icon_sha256 FROM roles WHERE id = $1`, r.ID).Scan(&oldIcon); err != nil {
					return nil, err
				}
				if _, err := tx.Exec(ctx, `UPDATE roles SET icon_emoji = $2, icon_sha256 = NULL, icon_content_type = NULL WHERE id = $1`,
					r.ID, *b.IconEmoji); err != nil {
					return nil, err
				}
			}
			updated, err := scanRole(tx.QueryRow(ctx, `
				UPDATE roles SET name = COALESCE($3, name), permissions = COALESCE($4, permissions),
				                 color = CASE WHEN $5::text IS NOT NULL THEN $5 WHEN $6 THEN NULL ELSE color END,
				                 hoist = COALESCE($7, hoist), self_assignable = COALESCE($8, self_assignable),
				                 mentionable = COALESCE($9, mentionable), description = COALESCE($10, description)
				WHERE id = $1 AND community_id = $2
				RETURNING `+roleCols,
				r.ID, a.CommunityID, b.Name, newPerms, b.Color, b.ClearColor, b.Hoist, b.SelfAssignable, b.Mentionable, desc))
			if err != nil {
				return nil, err
			}
			if cs := roleChanges(r, updated); len(cs) > 0 {
				if err := audit.Record(ctx, tx, audit.RoleUpdate, r.ID, audit.LogDetails{Name: updated.Name, Changes: cs}); err != nil {
					return nil, err
				}
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			if oldIcon != nil {
				s.removeIconBlob(ctx, *oldIcon)
			}
			s.bus.Publish(events.Event{Type: "ROLE_UPDATE", Data: updated, Scope: events.Scope{CommunityID: a.CommunityID}})
			if updated.Position != r.Position {
				lo, hi := min(r.Position, updated.Position), max(r.Position, updated.Position)
				if err := s.publishMoved(ctx, a.CommunityID, lo, hi, r.ID); err != nil {
					return nil, err
				}
			}
			return &struct{ Body *Role }{updated}, nil
		})

	huma.Register(api, op("delete-role", http.MethodDelete, "/api/server/roles/{roleID}", http.StatusNoContent),
		func(ctx context.Context, in *rolePath) (*struct{}, error) {
			a, err := s.requireActor(ctx, perms.ManageRoles)
			if err != nil {
				return nil, err
			}
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback(ctx)
			r, err := lockedRole(ctx, tx, a.CommunityID, in.RoleID)
			if err != nil {
				return nil, err
			}
			if r.ID == a.CommunityID {
				return nil, httpx.BadRequest("CANNOT_DELETE_EVERYONE", "the @everyone role cannot be deleted")
			}
			if r.IsGuest {
				return nil, httpx.E(http.StatusConflict, "CANNOT_DELETE_GUEST_ROLE", "the Guest role cannot be deleted")
			}
			rank, err := s.rank(ctx, tx, a.CommunityID, a.Member.UserID)
			if err != nil {
				return nil, err
			}
			if err := canEditRole(rank, r); err != nil {
				return nil, err
			}
			if err := canTouch(a, r.Permissions); err != nil {
				return nil, err
			}
			if _, err := tx.Exec(ctx, `DELETE FROM roles WHERE id = $1`, r.ID); err != nil {
				return nil, err
			}
			if _, err := tx.Exec(ctx, `UPDATE roles SET position = position - 1 WHERE community_id = $1 AND position > $2`,
				a.CommunityID, r.Position); err != nil {
				return nil, err
			}
			if err := audit.Record(ctx, tx, audit.RoleDelete, r.ID, audit.LogDetails{Name: r.Name}); err != nil {
				return nil, err
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			s.bus.Publish(events.Event{Type: "ROLE_DELETE", Data: RoleDeleted{ID: r.ID},
				Scope: events.Scope{CommunityID: a.CommunityID}})
			return nil, s.publishMoved(ctx, a.CommunityID, r.Position, ownerRank, 0)
		})

	assign := func(add bool) func(context.Context, *memberRolePath) (*struct{}, error) {
		return func(ctx context.Context, in *memberRolePath) (*struct{}, error) {
			a, err := s.requireActor(ctx, perms.ManageRoles)
			if err != nil {
				return nil, err
			}
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback(ctx)
			r, err := lockedRole(ctx, tx, a.CommunityID, in.RoleID)
			if err != nil {
				return nil, err
			}
			if r.ID == a.CommunityID {
				return nil, httpx.BadRequest("CANNOT_ASSIGN_EVERYONE", "every member holds @everyone")
			}
			rank, err := s.rank(ctx, tx, a.CommunityID, a.Member.UserID)
			if err != nil {
				return nil, err
			}
			if err := canEditRole(rank, r); err != nil {
				return nil, err
			}
			if err := canTouch(a, r.Permissions); err != nil {
				return nil, err
			}
			target, err := httpx.ParseID(in.UserID, "member")
			if err != nil {
				return nil, err
			}
			if _, err := s.member(ctx, a.CommunityID, target); errors.Is(err, ErrNotMember) {
				return nil, httpx.NotFound("member")
			} else if err != nil {
				return nil, err
			}
			if target != a.Member.UserID { // you may drop your own roles, but only moderate those below you
				theirs, err := s.rank(ctx, tx, a.CommunityID, target)
				if err != nil {
					return nil, err
				}
				if rank <= theirs {
					return nil, httpx.MissingPermission()
				}
			}
			sql := `DELETE FROM member_roles WHERE community_id = $1 AND user_id = $2 AND role_id = $3`
			if add {
				sql = `INSERT INTO member_roles (community_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`
			}
			tag, err := tx.Exec(ctx, sql, a.CommunityID, target, r.ID)
			if err != nil {
				return nil, err
			}
			if tag.RowsAffected() > 0 {
				action := audit.MemberRoleRemove
				if add {
					action = audit.MemberRoleAdd
				}
				if err := audit.Record(ctx, tx, action, target, audit.LogDetails{Role: &audit.LogRef{ID: r.ID, Name: r.Name}}); err != nil {
					return nil, err
				}
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			return nil, s.publishMemberUpdate(ctx, a.CommunityID, target)
		}
	}
	huma.Register(api, op("add-member-role", http.MethodPut,
		"/api/server/members/{userID}/roles/{roleID}", http.StatusNoContent), assign(true))
	huma.Register(api, op("remove-member-role", http.MethodDelete,
		"/api/server/members/{userID}/roles/{roleID}", http.StatusNoContent), assign(false))

	huma.Register(api, op("list-bans", http.MethodGet, "/api/server/bans", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body []Ban }, error) {
			a, err := s.requireActor(ctx, perms.Ban)
			if err != nil {
				return nil, err
			}
			bans, err := s.bans(ctx, a.CommunityID)
			return &struct{ Body []Ban }{bans}, err
		})

	huma.Register(api, op("ban-member", http.MethodPut, "/api/server/bans/{userID}", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			UserID string `path:"userID"`
			Body   BanRequest
		}) (*struct{}, error) {
			a, err := s.requireActor(ctx, perms.Ban)
			if err != nil {
				return nil, err
			}
			target, err := httpx.ParseID(in.UserID, "user")
			if err != nil {
				return nil, err
			}
			if target == auth.Current(ctx).User.ID {
				return nil, httpx.BadRequest("CANNOT_BAN_SELF", "you cannot ban yourself")
			}
			sv, err := s.Server(ctx)
			if err != nil {
				return nil, err
			}
			if target == sv.OwnerID {
				return nil, httpx.MissingPermission()
			}
			if err := s.canModerate(ctx, a, target); err != nil {
				return nil, err
			}
			users, err := s.users.PublicUsers(ctx, []id.ID{target})
			if err != nil {
				return nil, err
			}
			if _, ok := users[target]; !ok {
				return nil, httpx.NotFound("user")
			}
			if err := s.ban(ctx, a.CommunityID, target, in.Body.Reason); err != nil {
				return nil, err
			}
			if err := audit.Record(ctx, s.db, audit.MemberBan, target, audit.LogDetails{Reason: in.Body.Reason}); err != nil {
				return nil, err
			}
			signOut := s.users.RevokeSessions
			if users[target].GuestExpiresAt != nil {
				signOut = s.users.RetireUser // a banned guest is retired for good
			}
			if err := signOut(ctx, target); err != nil {
				slog.ErrorContext(ctx, "signing out a banned user", "user", target, "err", err)
			}
			return nil, nil
		})

	huma.Register(api, op("unban-member", http.MethodDelete, "/api/server/bans/{userID}", http.StatusNoContent),
		func(ctx context.Context, in *memberPath) (*struct{}, error) {
			a, err := s.requireActor(ctx, perms.Ban)
			if err != nil {
				return nil, err
			}
			target, err := httpx.ParseID(in.UserID, "ban")
			if err != nil {
				return nil, err
			}
			tag, err := s.db.Exec(ctx, `DELETE FROM bans WHERE community_id = $1 AND user_id = $2`, a.CommunityID, target)
			if err != nil {
				return nil, err
			}
			if tag.RowsAffected() == 0 {
				return nil, httpx.NotFound("ban")
			}
			return nil, audit.Record(ctx, s.db, audit.MemberUnban, target, audit.LogDetails{})
		})
}

func (s *Service) ban(ctx context.Context, communityID, userID id.ID, reason string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO bans (community_id, user_id, reason) VALUES ($1, $2, $3)
		ON CONFLICT (community_id, user_id) DO UPDATE SET reason = EXCLUDED.reason`,
		communityID, userID, reason); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM members WHERE community_id = $1 AND user_id = $2`, communityID, userID)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		s.publishMemberRemoved(communityID, userID)
	}
	return nil
}

func (s *Service) bans(ctx context.Context, communityID id.ID) ([]Ban, error) {
	rows, err := s.db.Query(ctx, `SELECT user_id, reason, created_at FROM bans WHERE community_id = $1 ORDER BY created_at`, communityID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Ban{}
	var ids []id.ID
	for rows.Next() {
		var b Ban
		if err := rows.Scan(&b.User.ID, &b.Reason, &b.CreatedAt); err != nil {
			return nil, err
		}
		ids = append(ids, b.User.ID)
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	users, err := s.users.PublicUsers(ctx, ids)
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i].User = users[out[i].User.ID]
	}
	return out, nil
}
