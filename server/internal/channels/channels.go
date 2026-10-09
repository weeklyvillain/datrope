// Package channels owns channels, permission overrides, and DMs, and
// answers "what may this user do in this channel?" for everyone else.
package channels

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

const (
	TypeText    = "text"
	TypeVoice   = "voice"
	TypeWelcome = "welcome" // exactly one per server; its content is the welcome page
	TypeDM      = "dm"
	TypeThread  = "thread" // started from a message; uses its parent channel's permissions
)

var ErrNotFound = errors.New("channel not found")

// Communities is what this package needs from communities.
type Communities interface {
	ServerID(ctx context.Context) (id.ID, error)
	PermMember(ctx context.Context, communityID, userID id.ID) (communities.PermMember, error)
	PermMembers(ctx context.Context, communityID id.ID) ([]communities.PermMember, error)
	SharesCommunity(ctx context.Context, a, b id.ID) (bool, error)
	HasRole(ctx context.Context, communityID, roleID id.ID) (bool, error)
}

type Users interface {
	PublicUsers(ctx context.Context, ids []id.ID) (map[id.ID]auth.PublicUser, error)
}

type Override struct {
	TargetType string      `json:"target_type" enum:"role,member"`
	TargetID   id.ID       `json:"target_id"`
	Allow      perms.Perms `json:"allow"`
	Deny       perms.Perms `json:"deny"`
}

type Channel struct {
	ID           id.ID             `json:"id"`
	CommunityID  *id.ID            `json:"-"` // nil for DMs
	Type         string            `json:"type" enum:"text,voice,welcome,dm,thread"`
	Name         string            `json:"name"`
	Position     int               `json:"position" doc:"Dense index inside the channel's group (its category, or none)"`
	CategoryID   *id.ID            `json:"category_id,omitempty"`
	Topic        string            `json:"topic"`
	Overrides    []Override        `json:"overrides"`
	Participants []auth.PublicUser `json:"participants,omitempty" doc:"DMs only"`

	ParentChannelID *id.ID `json:"parent_channel_id,omitempty" doc:"Threads only"`
	ParentMessageID *id.ID `json:"parent_message_id,omitempty" doc:"Threads only; the message the thread was started from"`
}

type ChannelDeleted struct {
	ID id.ID `json:"id"`
}

type Service struct {
	db          *pgxpool.Pool
	bus         *events.Bus
	communities Communities
	users       Users
}

func NewService(pool *pgxpool.Pool, bus *events.Bus, c Communities, u Users) *Service {
	return &Service{db: pool, bus: bus, communities: c, users: u}
}

// SeedCommunity implements communities.ChannelSeeder.
func (s *Service) SeedCommunity(ctx context.Context, tx pgx.Tx, communityID id.ID) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO channels (id, community_id, type, name, position)
		VALUES ($1, $3, 'welcome', 'welcome', 0), ($2, $3, 'text', 'general', 1)`,
		id.New(), id.New(), communityID)
	return err
}

const channelCols = `id, community_id, type, name, position, category_id, topic, parent_channel_id, parent_message_id`

func scanChannel(row pgx.Row) (*Channel, error) {
	var c Channel
	var cid, catID, parentCh, parentMsg *int64
	if err := row.Scan(&c.ID, &cid, &c.Type, &c.Name, &c.Position, &catID, &c.Topic, &parentCh, &parentMsg); err != nil {
		return nil, err
	}
	c.CommunityID = id.FromNullable(cid)
	c.CategoryID = id.FromNullable(catID)
	c.ParentChannelID = id.FromNullable(parentCh)
	c.ParentMessageID = id.FromNullable(parentMsg)
	c.Overrides = []Override{}
	return &c, nil
}

func (s *Service) query(ctx context.Context, sql string, args ...any) ([]*Channel, error) {
	rows, err := s.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Channel
	for rows.Next() {
		c, err := scanChannel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := s.loadOverrides(ctx, out); err != nil {
		return nil, err
	}
	return out, s.loadParticipants(ctx, out)
}

func (s *Service) get(ctx context.Context, channelID id.ID) (*Channel, error) {
	chs, err := s.query(ctx, `SELECT `+channelCols+` FROM channels WHERE id = $1`, channelID)
	if err != nil {
		return nil, err
	}
	if len(chs) == 0 {
		return nil, ErrNotFound
	}
	return chs[0], nil
}

// Get returns a channel by ID, or ErrNotFound. It does not check access.
func (s *Service) Get(ctx context.Context, channelID id.ID) (*Channel, error) {
	return s.get(ctx, channelID)
}

func (s *Service) loadOverrides(ctx context.Context, chs []*Channel) error {
	byID := map[id.ID]*Channel{}
	var ids []id.ID
	for _, c := range chs {
		if c.Type != TypeDM && c.Type != TypeThread { // threads use their parent's overrides
			byID[c.ID] = c
			ids = append(ids, c.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.db.Query(ctx, `
		SELECT channel_id, target_type, target_id, allow, deny FROM channel_overrides
		WHERE channel_id = ANY($1) ORDER BY target_type, target_id`, id.Int64s(ids))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid id.ID
		var o Override
		var allow, deny int64
		if err := rows.Scan(&cid, &o.TargetType, &o.TargetID, &allow, &deny); err != nil {
			return err
		}
		o.Allow, o.Deny = perms.Perms(allow), perms.Perms(deny)
		byID[cid].Overrides = append(byID[cid].Overrides, o)
	}
	return rows.Err()
}

func (s *Service) loadParticipants(ctx context.Context, chs []*Channel) error {
	byID := map[id.ID]*Channel{}
	var ids []id.ID
	for _, c := range chs {
		if c.Type == TypeDM {
			byID[c.ID] = c
			ids = append(ids, c.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.db.Query(ctx, `SELECT channel_id, user_id FROM dm_participants WHERE channel_id = ANY($1) ORDER BY user_id`,
		id.Int64s(ids))
	if err != nil {
		return err
	}
	defer rows.Close()
	type pair struct{ channel, user id.ID }
	var pairs []pair
	var userIDs []id.ID
	for rows.Next() {
		var p pair
		if err := rows.Scan(&p.channel, &p.user); err != nil {
			return err
		}
		pairs = append(pairs, p)
		userIDs = append(userIDs, p.user)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	users, err := s.users.PublicUsers(ctx, userIDs)
	if err != nil {
		return err
	}
	for _, p := range pairs {
		byID[p.channel].Participants = append(byID[p.channel].Participants, users[p.user])
	}
	return nil
}

// effective applies the channel's overrides to a server member.
func effective(m communities.PermMember, c *Channel) perms.Perms {
	if m.Gated {
		if c.Type == TypeWelcome {
			return perms.ViewChannel
		}
		return 0
	}
	held := make(map[id.ID]bool, len(m.RoleIDs))
	for _, r := range m.RoleIDs {
		held[r] = true
	}
	var pc perms.Channel
	for _, o := range c.Overrides {
		ov := perms.Override{Allow: o.Allow, Deny: o.Deny}
		switch {
		case o.TargetType == "role" && o.TargetID == *c.CommunityID:
			pc.Everyone = ov
		case o.TargetType == "role" && held[o.TargetID]:
			pc.Roles = append(pc.Roles, ov)
		case o.TargetType == "member" && o.TargetID == m.UserID:
			pc.Member = &ov
		}
	}
	return perms.Effective(m.Perms, pc)
}

// permsIn returns userID's permissions in c. A thread uses its parent's.
func (s *Service) permsIn(ctx context.Context, userID id.ID, c *Channel) (perms.Perms, error) {
	if c.Type == TypeThread {
		parent, err := s.get(ctx, *c.ParentChannelID)
		if err != nil {
			return 0, err
		}
		return s.permsIn(ctx, userID, parent)
	}
	if c.Type == TypeDM {
		for _, p := range c.Participants {
			if p.ID == userID {
				return perms.DM, nil
			}
		}
		return 0, nil
	}
	m, err := s.communities.PermMember(ctx, *c.CommunityID, userID)
	if errors.Is(err, communities.ErrNotMember) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return effective(m, c), nil
}

// Perms returns userID's permissions in a channel: zero if they cannot see
// it, ErrNotFound if it does not exist.
func (s *Service) Perms(ctx context.Context, userID, channelID id.ID) (perms.Perms, *Channel, error) {
	c, err := s.get(ctx, channelID)
	if err != nil {
		return 0, nil, err
	}
	p, err := s.permsIn(ctx, userID, c)
	return p, c, err
}

// Access loads a channel for a request. Channels the user cannot see are
// reported as missing (404); a missing `need` permission is a 403.
func (s *Service) Access(ctx context.Context, userID, channelID id.ID, need perms.Perms) (*Channel, perms.Perms, error) {
	p, c, err := s.Perms(ctx, userID, channelID)
	if errors.Is(err, ErrNotFound) || (err == nil && !p.Has(perms.ViewChannel)) {
		return nil, 0, httpx.NotFound("channel")
	}
	if err != nil {
		return nil, 0, err
	}
	if !p.Has(need) {
		return nil, 0, httpx.MissingPermission()
	}
	return c, p, nil
}

// Viewers returns everyone who can see a channel.
func (s *Service) Viewers(ctx context.Context, channelID id.ID) ([]id.ID, error) {
	c, err := s.get(ctx, channelID)
	if err != nil {
		return nil, err
	}
	return s.viewersOf(ctx, c)
}

func (s *Service) viewersOf(ctx context.Context, c *Channel) ([]id.ID, error) {
	if c.Type == TypeThread {
		parent, err := s.get(ctx, *c.ParentChannelID)
		if err != nil {
			return nil, err
		}
		return s.viewersOf(ctx, parent)
	}
	out := []id.ID{}
	if c.Type == TypeDM {
		for _, p := range c.Participants {
			out = append(out, p.ID)
		}
		return out, nil
	}
	members, err := s.communities.PermMembers(ctx, *c.CommunityID)
	if err != nil {
		return nil, err
	}
	for _, m := range members {
		if effective(m, c).Has(perms.ViewChannel) {
			out = append(out, m.UserID)
		}
	}
	return out, nil
}

// ListVisible returns the channels of the server that userID can see.
func (s *Service) ListVisible(ctx context.Context, userID, communityID id.ID) ([]Channel, error) {
	m, err := s.communities.PermMember(ctx, communityID, userID)
	if errors.Is(err, communities.ErrNotMember) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	chs, err := s.query(ctx, `
		SELECT `+channelCols+` FROM channels WHERE community_id = $1 AND type <> 'thread'
		ORDER BY category_id NULLS FIRST, (type = 'welcome') DESC, position, id`, communityID)
	if err != nil {
		return nil, err
	}
	out := []Channel{}
	for _, c := range chs {
		if effective(m, c).Has(perms.ViewChannel) {
			out = append(out, *c)
		}
	}
	return out, nil
}

func (s *Service) ListDMs(ctx context.Context, userID id.ID) ([]Channel, error) {
	chs, err := s.query(ctx, `
		SELECT c.id, c.community_id, c.type, c.name, c.position, c.category_id, c.topic, c.parent_channel_id, c.parent_message_id
		FROM channels c JOIN dm_participants p ON p.channel_id = c.id
		WHERE p.user_id = $1 ORDER BY c.id DESC`, userID)
	if err != nil {
		return nil, err
	}
	out := make([]Channel, 0, len(chs))
	for _, c := range chs {
		out = append(out, *c)
	}
	return out, nil
}

// publishVisibility tells current viewers about the channel and tells
// anyone in `before` who can no longer see it that it is gone.
func (s *Service) publishVisibility(ctx context.Context, channelID id.ID, before []id.ID) error {
	c, err := s.get(ctx, channelID)
	if err != nil {
		return err
	}
	after, err := s.viewersOf(ctx, c)
	if err != nil {
		return err
	}
	s.bus.Publish(events.Event{Type: "CHANNEL_UPDATE", Data: c, Scope: events.Scope{UserIDs: after}})
	still := make(map[id.ID]bool, len(after))
	for _, u := range after {
		still[u] = true
	}
	var lost []id.ID
	for _, u := range before {
		if !still[u] {
			lost = append(lost, u)
		}
	}
	if len(lost) > 0 {
		s.bus.Publish(events.Event{Type: "CHANNEL_DELETE", Data: ChannelDeleted{ID: c.ID},
			Scope: events.Scope{UserIDs: lost}})
	}
	return nil
}
