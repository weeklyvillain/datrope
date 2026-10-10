// Package communities owns the server (the instance's one community), its
// roles, members, bans, and invites.
package communities

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

var (
	ErrNotMember = errors.New("not a member")
	ErrNotFound  = errors.New("no server yet")
)

// Users is what this package needs from auth.
type Users interface {
	PublicUsers(ctx context.Context, ids []id.ID) (map[id.ID]auth.PublicUser, error)
	RevokeSessions(ctx context.Context, userID id.ID) error
	RetireUser(ctx context.Context, userID id.ID) error
	ExpiredGuests(ctx context.Context, now time.Time, limit int) ([]id.ID, error)
}

// ChannelSeeder creates the server's default channels inside the server's
// creation transaction. The channels package implements it.
type ChannelSeeder interface {
	SeedCommunity(ctx context.Context, tx pgx.Tx, communityID id.ID) error
}

// Palettes a server can use; the client maps each to its accent colour.
var Palettes = []string{"emerald", "ocean", "violet", "amber", "rose", "mint"}

// Server is the instance's one community.
type Server struct {
	ID          id.ID     `json:"id" doc:"Also the ID of the @everyone role"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Palette     string    `json:"palette" enum:"emerald,ocean,violet,amber,rose,mint"`
	OwnerID     id.ID     `json:"owner_id"`
	CreatedAt   time.Time `json:"created_at"`
	IconURL     *string   `json:"icon_url,omitempty"`
	BannerURL   *string   `json:"banner_url,omitempty"`
	RulesGate   bool      `json:"rules_gate" doc:"New members see only the welcome page until they accept the rules"`
}

type ServerWithRoles struct {
	Server
	Roles []Role `json:"roles"`
}

type Role struct {
	ID          id.ID       `json:"id"`
	CommunityID id.ID       `json:"-"`
	Name        string      `json:"name"`
	Permissions perms.Perms `json:"permissions"`
	Position    int         `json:"position" doc:"Higher is more senior; @everyone is 0"`
	Color       *string     `json:"color,omitempty" enum:"#e74c3c,#f5a524,#2ecc71,#2dd4bf,#4aa3ff,#a78bfa,#fb7185,#969da2"`
	Hoist       bool        `json:"hoist" doc:"Members with this role are shown separately in the member list"`
	IsGuest     bool        `json:"is_guest,omitempty" doc:"The system role every guest holds; it cannot be deleted"`
	IconEmoji   string      `json:"icon_emoji,omitempty" doc:"A Unicode emoji, or custom:<emoji id>"`
	IconURL     string      `json:"icon_url,omitempty" doc:"An uploaded icon image (versioned URL)"`
}

// roleCols are the columns scanRole reads.
const roleCols = `id, community_id, name, permissions, position, color, hoist, is_guest, icon_emoji, icon_sha256`

type Member struct {
	User     auth.PublicUser `json:"user"`
	RoleIDs  []id.ID         `json:"role_ids" doc:"Excludes @everyone, which every member holds"`
	JoinedAt time.Time       `json:"joined_at"`
	// AcceptedRulesAt is null while the member has not accepted the rules.
	AcceptedRulesAt *time.Time `json:"accepted_rules_at,omitempty"`
}

// PermMember is a member as the permission calculation sees them.
type PermMember struct {
	UserID  id.ID
	RoleIDs []id.ID // includes @everyone (== the server ID)
	Perms   perms.Member
	Gated   bool // the rules gate hides everything but the welcome page
}

type MemberRemoved struct {
	UserID id.ID `json:"user_id"`
}

type Service struct {
	db       *pgxpool.Pool
	bus      *events.Bus
	users    Users
	seeder   ChannelSeeder
	images   Images
	presence Presence
	blobs    IconBlobs     // role icon images; nil until SetIconBlobs
	serverID atomic.Int64  // cached once the server exists
	done     chan struct{} // closed by Close to stop the guest sweep
	stop     sync.Once
}

func NewService(pool *pgxpool.Pool, bus *events.Bus, users Users) *Service {
	return &Service{db: pool, bus: bus, users: users, done: make(chan struct{})}
}

func (s *Service) SetChannelSeeder(c ChannelSeeder) { s.seeder = c }

// Images reports the server's icon and banner URLs. The files package implements it.
type Images interface {
	ServerImageURLs(ctx context.Context) (icon, banner string, err error)
}

func (s *Service) SetImages(i Images) { s.images = i }

// Presence reports who is online. The gateway implements it.
type Presence interface {
	StatusOf(userID id.ID) string
}

func (s *Service) SetPresence(p Presence) { s.presence = p }

// ServerID returns the server's ID: ErrNotFound until someone registers.
func (s *Service) ServerID(ctx context.Context) (id.ID, error) {
	if v := s.serverID.Load(); v != 0 {
		return id.ID(v), nil
	}
	var sid id.ID
	err := s.db.QueryRow(ctx, `SELECT id FROM communities WHERE is_server`).Scan(&sid)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	s.serverID.Store(int64(sid))
	return sid, nil
}

func (s *Service) Server(ctx context.Context) (*Server, error) {
	var sv Server
	err := s.db.QueryRow(ctx, `SELECT id, name, description, palette, owner_id, created_at, rules_gate FROM communities WHERE is_server`).
		Scan(&sv.ID, &sv.Name, &sv.Description, &sv.Palette, &sv.OwnerID, &sv.CreatedAt, &sv.RulesGate)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if s.images != nil {
		icon, banner, err := s.images.ServerImageURLs(ctx)
		if err != nil {
			return nil, err
		}
		if icon != "" {
			sv.IconURL = &icon
		}
		if banner != "" {
			sv.BannerURL = &banner
		}
	}
	return &sv, nil
}

// BasePerms is userID's server-wide permission set: 0 for non-members.
func (s *Service) BasePerms(ctx context.Context, userID id.ID) (perms.Perms, error) {
	sid, err := s.ServerID(ctx)
	if errors.Is(err, ErrNotFound) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	m, err := s.PermMember(ctx, sid, userID)
	if errors.Is(err, ErrNotMember) {
		return 0, nil
	}
	if err != nil || m.Gated {
		return 0, err
	}
	return perms.Base(m.Perms), nil
}

// PublishServerUpdate tells every member about the server's current settings.
func (s *Service) PublishServerUpdate(ctx context.Context) error {
	sv, err := s.Server(ctx)
	if err != nil {
		return err
	}
	s.bus.Publish(events.Event{Type: "SERVER_UPDATE", Data: sv, Scope: events.Scope{CommunityID: sv.ID}})
	return nil
}

func (s *Service) withRoles(ctx context.Context) (*ServerWithRoles, error) {
	sv, err := s.Server(ctx)
	if err != nil {
		return nil, err
	}
	roles, err := s.Roles(ctx, sv.ID)
	if err != nil {
		return nil, err
	}
	return &ServerWithRoles{Server: *sv, Roles: roles}, nil
}

// EnsureServer creates the server when there is none but there are users:
// it belongs to the oldest account, every account that is not disabled
// joins it, and it gets its default channels. It runs at startup and when
// the first user registers.
func (s *Service) EnsureServer(ctx context.Context) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(7300151)`); err != nil { // one creator at a time
		return err
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM communities WHERE is_server)`).Scan(&exists); err != nil || exists {
		return err
	}
	var owner id.ID
	err = tx.QueryRow(ctx, `SELECT id FROM users WHERE NOT disabled ORDER BY created_at, id LIMIT 1`).Scan(&owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // nobody has registered yet
	}
	if err != nil {
		return err
	}
	sid := id.New()
	if _, err := tx.Exec(ctx, `INSERT INTO communities (id, name, owner_id, is_server) VALUES ($1, 'Datrope', $2, true)`, sid, owner); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO roles (id, community_id, name, permissions, position) VALUES ($1, $1, '@everyone', $2, 0)`,
		sid, int64(perms.Default)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO members (community_id, user_id, accepted_rules_at) SELECT $1, id, now() FROM users WHERE NOT disabled`, sid); err != nil {
		return err
	}
	if s.seeder != nil {
		if err := s.seeder.SeedCommunity(ctx, tx, sid); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Join makes a newly registered user a member (auth.Joiner). The first
// registration creates the server; a non-empty code is redeemed as an invite.
func (s *Service) Join(ctx context.Context, code string, userID id.ID) error {
	if _, err := s.ServerID(ctx); errors.Is(err, ErrNotFound) {
		if err := s.EnsureServer(ctx); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	if code != "" {
		if err := s.Check(ctx, code); err != nil { // guest links do not make full members
			return err
		}
		return s.join(ctx, code, userID)
	}
	return s.addMember(ctx, userID)
}

// addMember joins userID without an invite (open registration). It does
// nothing if they are a member already.
func (s *Service) addMember(ctx context.Context, userID id.ID) error {
	sid, err := s.ServerID(ctx)
	if err != nil {
		return err
	}
	var banned bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM bans WHERE community_id = $1 AND user_id = $2)`, sid, userID).Scan(&banned); err != nil {
		return err
	}
	if banned {
		return httpx.E(http.StatusForbidden, "BANNED", "you are banned from this server")
	}
	tag, err := s.db.Exec(ctx, `INSERT INTO members (community_id, user_id, accepted_rules_at) VALUES ($1, $2, `+acceptedOnJoin+`) ON CONFLICT DO NOTHING`, sid, userID)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	return s.publishMemberAdd(ctx, sid, userID)
}

// acceptedOnJoin is a new member's accepted_rules_at ($1 is the server ID):
// joining while the gate is off counts as accepting, so turning the gate on
// later does not lock out existing members.
const acceptedOnJoin = `CASE WHEN (SELECT rules_gate FROM communities WHERE id = $1) THEN NULL ELSE now() END`

func (s *Service) publishMemberAdd(ctx context.Context, sid, userID id.ID) error {
	m, err := s.member(ctx, sid, userID)
	if err != nil {
		return err
	}
	s.bus.Publish(events.Event{Type: "MEMBER_ADD", Data: m, Scope: events.Scope{CommunityID: sid}})
	return nil
}

func (s *Service) Roles(ctx context.Context, communityID id.ID) ([]Role, error) {
	rows, err := s.db.Query(ctx, `
		SELECT `+roleCols+` FROM roles
		WHERE community_id = $1 ORDER BY position DESC, id`, communityID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Role{}
	for rows.Next() {
		r, err := scanRole(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

func scanRole(row pgx.Row) (*Role, error) {
	var r Role
	var p int64
	var iconSum *string
	if err := row.Scan(&r.ID, &r.CommunityID, &r.Name, &p, &r.Position, &r.Color, &r.Hoist, &r.IsGuest, &r.IconEmoji, &iconSum); err != nil {
		return nil, err
	}
	r.Permissions = perms.Perms(p)
	if iconSum != nil && len(*iconSum) >= 12 {
		r.IconURL = "/api/role-icons/" + r.ID.String() + "?v=" + (*iconSum)[:12]
	}
	return &r, nil
}

func (s *Service) Members(ctx context.Context, communityID id.ID) ([]Member, error) {
	return s.members(ctx, communityID, nil)
}

func (s *Service) member(ctx context.Context, communityID, userID id.ID) (*Member, error) {
	ms, err := s.members(ctx, communityID, &userID)
	if err != nil {
		return nil, err
	}
	if len(ms) == 0 {
		return nil, ErrNotMember
	}
	return &ms[0], nil
}

func (s *Service) members(ctx context.Context, communityID id.ID, only *id.ID) ([]Member, error) {
	rows, err := s.db.Query(ctx, `
		SELECT m.user_id, m.joined_at, m.accepted_rules_at,
		       COALESCE(array_agg(mr.role_id ORDER BY mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL), '{}')
		FROM members m
		LEFT JOIN member_roles mr ON mr.community_id = m.community_id AND mr.user_id = m.user_id
		WHERE m.community_id = $1 AND ($2::bigint IS NULL OR m.user_id = $2)
		GROUP BY m.user_id, m.joined_at, m.accepted_rules_at
		ORDER BY m.joined_at, m.user_id`, communityID, only)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Member{}
	var ids []id.ID
	for rows.Next() {
		m := Member{RoleIDs: []id.ID{}}
		var roles []int64
		if err := rows.Scan(&m.User.ID, &m.JoinedAt, &m.AcceptedRulesAt, &roles); err != nil {
			return nil, err
		}
		for _, r := range roles {
			m.RoleIDs = append(m.RoleIDs, id.ID(r))
		}
		ids = append(ids, m.User.ID)
		out = append(out, m)
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

// PermMember returns ErrNotMember if userID is not in the community (or it
// does not exist).
func (s *Service) PermMember(ctx context.Context, communityID, userID id.ID) (PermMember, error) {
	ms, err := s.permMembers(ctx, communityID, &userID)
	if err != nil {
		return PermMember{}, err
	}
	if len(ms) == 0 {
		return PermMember{}, ErrNotMember
	}
	return ms[0], nil
}

func (s *Service) PermMembers(ctx context.Context, communityID id.ID) ([]PermMember, error) {
	return s.permMembers(ctx, communityID, nil)
}

func (s *Service) permMembers(ctx context.Context, communityID id.ID, only *id.ID) ([]PermMember, error) {
	var ownerID id.ID
	var rulesGate bool
	err := s.db.QueryRow(ctx, `SELECT owner_id, rules_gate FROM communities WHERE id = $1`, communityID).Scan(&ownerID, &rulesGate)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	roles, err := s.Roles(ctx, communityID)
	if err != nil {
		return nil, err
	}
	mask := make(map[id.ID]perms.Perms, len(roles))
	for _, r := range roles {
		mask[r.ID] = r.Permissions
	}
	rows, err := s.db.Query(ctx, `
		SELECT m.user_id, m.accepted_rules_at IS NULL,
		       COALESCE(array_agg(mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL), '{}')
		FROM members m
		LEFT JOIN member_roles mr ON mr.community_id = m.community_id AND mr.user_id = m.user_id
		WHERE m.community_id = $1 AND ($2::bigint IS NULL OR m.user_id = $2)
		GROUP BY m.user_id, m.accepted_rules_at`, communityID, only)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PermMember{}
	for rows.Next() {
		var uid id.ID
		var notAccepted bool
		var roleIDs []int64
		if err := rows.Scan(&uid, &notAccepted, &roleIDs); err != nil {
			return nil, err
		}
		pm := PermMember{
			UserID:  uid,
			RoleIDs: []id.ID{communityID},
			Perms:   perms.Member{IsOwner: uid == ownerID, Roles: []perms.Perms{mask[communityID]}},
			Gated:   rulesGate && notAccepted && uid != ownerID,
		}
		for _, r := range roleIDs {
			pm.RoleIDs = append(pm.RoleIDs, id.ID(r))
			pm.Perms.Roles = append(pm.Perms.Roles, mask[id.ID(r)])
		}
		out = append(out, pm)
	}
	return out, rows.Err()
}

func (s *Service) MemberIDs(ctx context.Context, communityID id.ID) ([]id.ID, error) {
	rows, err := s.db.Query(ctx, `SELECT user_id FROM members WHERE community_id = $1`, communityID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[id.ID])
}

// CoMemberIDs returns everyone who shares at least one community with
// userID, including userID if they are in any community.
func (s *Service) CoMemberIDs(ctx context.Context, userID id.ID) ([]id.ID, error) {
	rows, err := s.db.Query(ctx, `
		SELECT DISTINCT b.user_id FROM members a JOIN members b ON a.community_id = b.community_id
		WHERE a.user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[id.ID])
}

func (s *Service) SharesCommunity(ctx context.Context, a, b id.ID) (bool, error) {
	var ok bool
	err := s.db.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM members x JOIN members y ON x.community_id = y.community_id
		               JOIN communities c ON c.id = x.community_id
		               WHERE x.user_id = $1 AND y.user_id = $2
		                 AND (NOT c.rules_gate OR ((x.accepted_rules_at IS NOT NULL OR x.user_id = c.owner_id)
		                                       AND (y.accepted_rules_at IS NOT NULL OR y.user_id = c.owner_id))))`, a, b).Scan(&ok)
	return ok, err
}

func (s *Service) HasRole(ctx context.Context, communityID, roleID id.ID) (bool, error) {
	var ok bool
	err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM roles WHERE id = $1 AND community_id = $2)`,
		roleID, communityID).Scan(&ok)
	return ok, err
}

// removeMember deletes a membership and reports whether it existed.
func (s *Service) removeMember(ctx context.Context, communityID, userID id.ID) (bool, error) {
	tag, err := s.db.Exec(ctx, `DELETE FROM members WHERE community_id = $1 AND user_id = $2`, communityID, userID)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	s.publishMemberRemoved(communityID, userID)
	return true, nil
}

func (s *Service) publishMemberRemoved(communityID, userID id.ID) {
	s.bus.Publish(events.Event{Type: "MEMBER_REMOVE", Data: MemberRemoved{UserID: userID},
		Scope: events.Scope{CommunityID: communityID, UserIDs: []id.ID{userID}}})
}
