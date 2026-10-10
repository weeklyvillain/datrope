package channels

import (
	"context"
	"errors"
	"math"
	"net/http"
	"slices"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type CreateChannelRequest struct {
	Name       string `json:"name" minLength:"1" maxLength:"100"`
	Type       string `json:"type" enum:"text,voice,webhook,announcement,forum,gallery"`
	CategoryID *id.ID `json:"category_id,omitempty"`

	Tags       []string `json:"tags,omitempty" maxItems:"20" doc:"Forums only"`
	RequireTag bool     `json:"require_tag,omitempty" doc:"Forums only: a post needs at least one tag"`
}

type UpdateChannelRequest struct {
	Name          *string `json:"name,omitempty" minLength:"1" maxLength:"100"`
	Topic         *string `json:"topic,omitempty" maxLength:"1024"`
	CategoryID    *id.ID  `json:"category_id,omitempty" doc:"Move into this category"`
	ClearCategory bool    `json:"clear_category,omitempty" doc:"Move out of any category"`
	Position      *int    `json:"position,omitempty" minimum:"0" doc:"Index inside the channel's (new) group"`

	Tags       *[]string `json:"tags,omitempty" maxItems:"20" doc:"Forums only; replaces the tag list and strips removed tags from existing posts"`
	RequireTag *bool     `json:"require_tag,omitempty" doc:"Forums only"`
}

type OverrideRequest struct {
	Allow perms.Perms `json:"allow"`
	Deny  perms.Perms `json:"deny"`
}

type CreateDMRequest struct {
	RecipientIDs []id.ID `json:"recipient_ids" minItems:"1" maxItems:"9"`
}

type channelPath struct {
	ID string `path:"id"`
}

type overridePath struct {
	ID         string `path:"id"`
	TargetType string `path:"targetType" enum:"role,member"`
	TargetID   string `path:"targetID"`
}

func Register(api huma.API, s *Service) {
	tags := []string{"channels"}
	op := func(id, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}
	me := func(ctx context.Context) id.ID { return auth.Current(ctx).User.ID }
	registerCategories(api, s, op)

	huma.Register(api, op("list-channels", http.MethodGet, "/api/server/channels", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body []Channel }, error) {
			sid, err := s.serverID(ctx)
			if err != nil {
				return nil, err
			}
			chs, err := s.ListVisible(ctx, me(ctx), sid)
			if errors.Is(err, ErrNotFound) {
				return nil, errNotMember()
			}
			return &struct{ Body []Channel }{chs}, err
		})

	huma.Register(api, op("create-channel", http.MethodPost, "/api/server/channels", http.StatusCreated),
		func(ctx context.Context, in *struct{ Body CreateChannelRequest }) (*struct{ Body *Channel }, error) {
			cid, err := s.serverID(ctx)
			if err != nil {
				return nil, err
			}
			m, err := s.communities.PermMember(ctx, cid, me(ctx))
			if errors.Is(err, communities.ErrNotMember) {
				return nil, errNotMember()
			}
			if err != nil {
				return nil, err
			}
			if m.Gated || !perms.Base(m.Perms).Has(perms.ManageChannels) {
				return nil, httpx.MissingPermission()
			}
			var tags []string
			if in.Body.Type != TypeForum && (len(in.Body.Tags) > 0 || in.Body.RequireTag) {
				return nil, httpx.BadRequest("VALIDATION_FAILED", "only forums have tags")
			}
			if tags, err = normalizeTags(in.Body.Tags, maxTags); err != nil {
				return nil, err
			}
			if in.Body.RequireTag && len(tags) == 0 {
				return nil, errRequireTagWithoutTags()
			}
			newID := id.New()
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback(ctx)
			if err := lockOrder(ctx, tx, cid); err != nil {
				return nil, err
			}
			if in.Body.CategoryID != nil {
				if _, err := s.category(ctx, tx, cid, in.Body.CategoryID.String()); err != nil {
					return nil, err
				}
			}
			group, err := groupIDs(ctx, tx, cid, in.Body.CategoryID, 0)
			if err != nil {
				return nil, err
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO channels (id, community_id, type, name, position, category_id, tags, require_tag)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
				newID, cid, in.Body.Type, strings.TrimSpace(in.Body.Name), len(group), in.Body.CategoryID, tags, in.Body.RequireTag); err != nil {
				return nil, err
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			c, err := s.get(ctx, newID)
			if err != nil {
				return nil, err
			}
			s.bus.Publish(events.Event{Type: "CHANNEL_CREATE", Data: c, Scope: events.Scope{ChannelID: c.ID}})
			return &struct{ Body *Channel }{c}, nil
		})

	huma.Register(api, op("get-channel", http.MethodGet, "/api/channels/{id}", 0),
		func(ctx context.Context, in *channelPath) (*struct{ Body *Channel }, error) {
			chID, err := httpx.ParseID(in.ID, "channel")
			if err != nil {
				return nil, err
			}
			c, _, err := s.Access(ctx, me(ctx), chID, perms.ViewChannel)
			if err != nil {
				return nil, err
			}
			return &struct{ Body *Channel }{c}, nil
		})

	huma.Register(api, op("update-channel", http.MethodPatch, "/api/channels/{id}", 0),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body UpdateChannelRequest
		}) (*struct{ Body *Channel }, error) {
			chID, err := httpx.ParseID(in.ID, "channel")
			if err != nil {
				return nil, err
			}
			c, _, err := s.Access(ctx, me(ctx), chID, perms.ManageChannels)
			if err != nil {
				return nil, err
			}
			var tags []string
			if in.Body.Tags != nil || in.Body.RequireTag != nil {
				if c.Type != TypeForum {
					return nil, httpx.BadRequest("VALIDATION_FAILED", "only forums have tags")
				}
			}
			if in.Body.Tags != nil {
				if tags, err = normalizeTags(*in.Body.Tags, maxTags); err != nil {
					return nil, err
				}
			}
			if c.Type == TypeForum {
				requireTag, finalTags := c.RequireTag, c.Tags
				if in.Body.RequireTag != nil {
					requireTag = *in.Body.RequireTag
				}
				if tags != nil {
					finalTags = tags
				}
				if requireTag && len(finalTags) == 0 {
					return nil, errRequireTagWithoutTags()
				}
			}
			if in.Body.CategoryID != nil || in.Body.ClearCategory || in.Body.Position != nil {
				if err := s.moveChannel(ctx, c, in.Body); err != nil {
					return nil, err
				}
			}
			var name, topic *string
			if in.Body.Name != nil {
				n := strings.TrimSpace(*in.Body.Name)
				name = &n
			}
			if in.Body.Topic != nil {
				t := strings.TrimSpace(*in.Body.Topic)
				topic = &t
			}
			if name != nil || topic != nil {
				if _, err := s.db.Exec(ctx, `UPDATE channels SET name = COALESCE($2, name), topic = COALESCE($3, topic) WHERE id = $1`,
					chID, name, topic); err != nil {
					return nil, err
				}
			}
			if in.Body.Tags != nil || in.Body.RequireTag != nil {
				if err := s.updateForumTags(ctx, chID, tags, in.Body.RequireTag); err != nil {
					return nil, err
				}
			}
			c, err = s.get(ctx, chID)
			if err != nil {
				return nil, err
			}
			s.bus.Publish(events.Event{Type: "CHANNEL_UPDATE", Data: c, Scope: events.Scope{ChannelID: c.ID}})
			return &struct{ Body *Channel }{c}, nil
		})

	huma.Register(api, op("delete-channel", http.MethodDelete, "/api/channels/{id}", http.StatusNoContent),
		func(ctx context.Context, in *channelPath) (*struct{}, error) {
			chID, err := httpx.ParseID(in.ID, "channel")
			if err != nil {
				return nil, err
			}
			c, _, err := s.Access(ctx, me(ctx), chID, perms.ManageChannels)
			if err != nil {
				return nil, err
			}
			if c.Type == TypeWelcome {
				return nil, httpx.BadRequest("CANNOT_DELETE_WELCOME", "the welcome channel cannot be deleted")
			}
			viewers, err := s.viewersOf(ctx, c)
			if err != nil {
				return nil, err
			}
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback(ctx)
			if c.CommunityID != nil {
				if err := lockOrder(ctx, tx, *c.CommunityID); err != nil {
					return nil, err
				}
			}
			var cat *int64
			if err := tx.QueryRow(ctx, `DELETE FROM channels WHERE id = $1 RETURNING category_id`, chID).Scan(&cat); err != nil {
				return nil, err
			}
			var shifted []id.ID
			if c.CommunityID != nil {
				if shifted, err = renumberGroup(ctx, tx, *c.CommunityID, id.FromNullable(cat)); err != nil {
					return nil, err
				}
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			s.bus.Publish(events.Event{Type: "CHANNEL_DELETE", Data: ChannelDeleted{ID: c.ID},
				Scope: events.Scope{UserIDs: viewers}})
			s.announceMoved(ctx, shifted, 0)
			return nil, nil
		})

	huma.Register(api, op("put-override", http.MethodPut, "/api/channels/{id}/overrides/{targetType}/{targetID}", 0),
		func(ctx context.Context, in *struct {
			ID         string `path:"id"`
			TargetType string `path:"targetType" enum:"role,member"`
			TargetID   string `path:"targetID"`
			Body       OverrideRequest
		}) (*struct{ Body *Channel }, error) {
			c, target, before, err := s.overrideTarget(ctx, overridePath{ID: in.ID, TargetType: in.TargetType, TargetID: in.TargetID}, in.Body.Allow|in.Body.Deny)
			if err != nil {
				return nil, err
			}
			if _, err := s.db.Exec(ctx, `
				INSERT INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES ($1, $2, $3, $4, $5)
				ON CONFLICT (channel_id, target_type, target_id) DO UPDATE SET allow = EXCLUDED.allow, deny = EXCLUDED.deny`,
				c.ID, in.TargetType, target, int64(in.Body.Allow), int64(in.Body.Deny)); err != nil {
				return nil, err
			}
			if err := s.publishVisibility(ctx, c.ID, before); err != nil {
				return nil, err
			}
			updated, err := s.get(ctx, c.ID)
			return &struct{ Body *Channel }{updated}, err
		})

	huma.Register(api, op("delete-override", http.MethodDelete, "/api/channels/{id}/overrides/{targetType}/{targetID}", http.StatusNoContent),
		func(ctx context.Context, in *overridePath) (*struct{}, error) {
			c, target, before, err := s.overrideTarget(ctx, *in, 0)
			if err != nil {
				return nil, err
			}
			if _, err := s.db.Exec(ctx, `DELETE FROM channel_overrides WHERE channel_id = $1 AND target_type = $2 AND target_id = $3`,
				c.ID, in.TargetType, target); err != nil {
				return nil, err
			}
			return nil, s.publishVisibility(ctx, c.ID, before)
		})

	huma.Register(api, op("list-dms", http.MethodGet, "/api/dms", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body []Channel }, error) {
			chs, err := s.ListDMs(ctx, me(ctx))
			return &struct{ Body []Channel }{chs}, err
		})

	huma.Register(api, op("create-dm", http.MethodPost, "/api/dms", 0),
		func(ctx context.Context, in *struct{ Body CreateDMRequest }) (*struct{ Body *Channel }, error) {
			c, err := s.createDM(ctx, me(ctx), in.Body.RecipientIDs)
			return &struct{ Body *Channel }{c}, err
		})
}

// moveChannel changes a server channel's category and/or its index inside
// its group, renumbering the groups involved, and announces every other
// channel that moved. The welcome channel stays first and uncategorised.
func (s *Service) moveChannel(ctx context.Context, c *Channel, req UpdateChannelRequest) error {
	if c.CommunityID == nil {
		return httpx.BadRequest("VALIDATION_FAILED", "direct messages have no order")
	}
	if c.Type == TypeThread {
		return httpx.BadRequest("VALIDATION_FAILED", "threads have no order")
	}
	sid := *c.CommunityID
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockOrder(ctx, tx, sid); err != nil {
		return err
	}
	var cur *int64
	var curPos int
	if err := tx.QueryRow(ctx, `SELECT category_id, position FROM channels WHERE id = $1`, c.ID).Scan(&cur, &curPos); err != nil {
		return err
	}
	oldCategory := id.FromNullable(cur)
	newCategory := oldCategory
	switch {
	case req.CategoryID != nil:
		cat, err := s.category(ctx, tx, sid, req.CategoryID.String())
		if err != nil {
			return err
		}
		newCategory = &cat.ID
	case req.ClearCategory:
		newCategory = nil
	}
	if c.Type == TypeWelcome && (newCategory != nil || (req.Position != nil && *req.Position != 0)) {
		return httpx.BadRequest("WELCOME_STAYS", "the welcome channel stays at the top")
	}
	var pos int
	switch {
	case req.Position != nil && c.Type == TypeWelcome:
		pos = 0
	case req.Position != nil:
		if pos, err = s.fromVisibleIndex(ctx, tx, sid, c.ID, newCategory, *req.Position); err != nil {
			return err
		}
	case sameCategory(oldCategory, newCategory):
		pos = curPos // nothing to move
	default:
		pos = math.MaxInt32 // the end of the new group
	}
	if newCategory == nil && c.Type != TypeWelcome {
		pos = max(pos, 1) // below the welcome channel
	}
	changed, err := placeChannel(ctx, tx, sid, c.ID, oldCategory, newCategory, pos)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.announceMoved(ctx, changed, c.ID)
	return nil
}

// overrideTarget checks the caller may edit overrides on this channel with
// the given bits, validates the target, and returns the current viewers.
func (s *Service) overrideTarget(ctx context.Context, in overridePath, bits perms.Perms) (*Channel, id.ID, []id.ID, error) {
	chID, err := httpx.ParseID(in.ID, "channel")
	if err != nil {
		return nil, 0, nil, err
	}
	me := auth.Current(ctx).User.ID
	c, _, err := s.Access(ctx, me, chID, perms.ManageRoles)
	if err != nil {
		return nil, 0, nil, err
	}
	// You can only allow or deny permissions you hold. A webhook channel's
	// mask does not count: its overrides also govern its threads.
	held, err := s.permsIn(ctx, me, c)
	if err != nil {
		return nil, 0, nil, err
	}
	if !held.Has(bits) {
		return nil, 0, nil, httpx.MissingPermission()
	}
	if c.Type == TypeThread {
		return nil, 0, nil, httpx.BadRequest("VALIDATION_FAILED", "threads use their parent channel's permissions")
	}
	target, err := httpx.ParseID(in.TargetID, in.TargetType)
	if err != nil {
		return nil, 0, nil, err
	}
	if in.TargetType == "role" {
		ok, err := s.communities.HasRole(ctx, *c.CommunityID, target)
		if err != nil {
			return nil, 0, nil, err
		}
		if !ok {
			return nil, 0, nil, httpx.NotFound("role")
		}
	} else {
		_, err := s.communities.PermMember(ctx, *c.CommunityID, target)
		if errors.Is(err, communities.ErrNotMember) {
			return nil, 0, nil, httpx.NotFound("member")
		}
		if err != nil {
			return nil, 0, nil, err
		}
	}
	before, err := s.viewersOf(ctx, c)
	return c, target, before, err
}

func (s *Service) createDM(ctx context.Context, creator id.ID, recipients []id.ID) (*Channel, error) {
	others := []id.ID{}
	for _, r := range recipients {
		if r != creator && !slices.Contains(others, r) {
			others = append(others, r)
		}
	}
	if len(others) == 0 || len(others) != len(recipients) {
		return nil, httpx.BadRequest("INVALID_RECIPIENTS", "list 1 to 9 other users, without duplicates")
	}
	for _, r := range others {
		ok, err := s.communities.SharesCommunity(ctx, creator, r)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, httpx.E(http.StatusForbidden, "NO_SHARED_COMMUNITY", "you can only message people when you are both members of this server")
		}
	}
	if len(others) == 1 { // reuse an existing 1:1 conversation
		var existing id.ID
		err := s.db.QueryRow(ctx, `
			SELECT c.id FROM channels c
			JOIN dm_participants a ON a.channel_id = c.id AND a.user_id = $1
			JOIN dm_participants b ON b.channel_id = c.id AND b.user_id = $2
			WHERE c.type = 'dm' AND NOT c.dm_group AND (SELECT count(*) FROM dm_participants p WHERE p.channel_id = c.id) = 2
			LIMIT 1`, creator, others[0]).Scan(&existing)
		if err == nil {
			return s.get(ctx, existing)
		}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	chID := id.New()
	if _, err := tx.Exec(ctx, `INSERT INTO channels (id, type, dm_group) VALUES ($1, 'dm', $2)`, chID, len(others) > 1); err != nil {
		return nil, err
	}
	for _, u := range append(others, creator) {
		if _, err := tx.Exec(ctx, `INSERT INTO dm_participants (channel_id, user_id) VALUES ($1, $2)`, chID, u); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	c, err := s.get(ctx, chID)
	if err != nil {
		return nil, err
	}
	s.bus.Publish(events.Event{Type: "CHANNEL_CREATE", Data: c, Scope: events.Scope{ChannelID: c.ID}})
	return c, nil
}

func errNotMember() *httpx.Error {
	return httpx.E(http.StatusForbidden, "NOT_A_MEMBER", "you are not a member of this server; ask for an invite")
}

// serverID returns the server's ID; before anyone has registered there is
// no server and nobody is a member of it.
func (s *Service) serverID(ctx context.Context) (id.ID, error) {
	sid, err := s.communities.ServerID(ctx)
	if errors.Is(err, communities.ErrNotFound) {
		return 0, errNotMember()
	}
	return sid, err
}

func errRequireTagWithoutTags() error {
	return httpx.BadRequest("VALIDATION_FAILED", "a forum that requires a tag needs at least one tag; add a tag or turn off require tag")
}

// updateForumTags replaces a forum's tags (when tags is non-nil) and sets
// require_tag (when requireTag is non-nil). Tags removed from the forum are
// stripped from its posts in the same transaction.
func (s *Service) updateForumTags(ctx context.Context, forumID id.ID, tags []string, requireTag *bool) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if requireTag != nil {
		if _, err := tx.Exec(ctx, `UPDATE channels SET require_tag = $2 WHERE id = $1`, forumID, *requireTag); err != nil {
			return err
		}
	}
	if tags != nil {
		if _, err := tx.Exec(ctx, `UPDATE channels SET tags = $2 WHERE id = $1`, forumID, tags); err != nil {
			return err
		}
		// Post tags match the forum's ignoring case and take its new spelling.
		if _, err := tx.Exec(ctx, `
			UPDATE channels SET tags = ARRAY(
				SELECT n FROM unnest(tags) WITH ORDINALITY AS p(t, i)
				JOIN unnest($2::text[]) AS n ON lower(n) = lower(p.t)
				ORDER BY p.i)
			WHERE parent_channel_id = $1 AND type = 'thread'`, forumID, tags); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
