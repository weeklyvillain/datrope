package app

import (
	"context"
	"errors"
	"reflect"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/expressions"
	"github.com/datrope/datrope/server/internal/files"
	"github.com/datrope/datrope/server/internal/gateway"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/integrations"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/music"
	"github.com/datrope/datrope/server/internal/voice"
)

// Ready is the READY payload (architecture spec §5.2; one-server design §5).
type Ready struct {
	SessionID   string                   `json:"session_id"`
	User        *auth.User               `json:"user"`
	Server      *ReadyServer             `json:"server,omitempty" doc:"Absent when the user is not a member"`
	DMs         []channels.Channel       `json:"dms"`
	Presences   []gateway.PresenceUpdate `json:"presences" doc:"People who share the server and are not offline"`
	ReadStates  []messages.ReadState     `json:"read_states" doc:"One per visible channel and DM"`
	VoiceStates []voice.VoiceState       `json:"voice_states" doc:"Who is in voice, in channels and DMs the user can see"`
	Emoji       []expressions.Emoji      `json:"emoji" doc:"The server custom emoji; empty when the user is not a member"`
	Sounds      []expressions.Sound      `json:"sounds" doc:"The server soundboard sounds; empty when the user is not a member"`
	Activities  []integrations.Activity  `json:"activities" doc:"What people who share the server are doing on linked accounts"`
}

type ReadyServer struct {
	communities.Server
	Roles      []communities.Role   `json:"roles"`
	Members    []communities.Member `json:"members"`
	Channels   []channels.Channel   `json:"channels" doc:"Only channels the user can see"`
	Categories []channels.Category  `json:"categories" doc:"Empty for a member held at the rules gate"`
}

type readyBuilder struct {
	communities  *communities.Service
	channels     *channels.Service
	messages     *messages.Service
	voice        *voice.Service
	expressions  *expressions.Service
	integrations *integrations.Service
}

func (b readyBuilder) Build(ctx context.Context, u *auth.User, sessionID string, status func(id.ID) string) (any, error) {
	r := Ready{SessionID: sessionID, User: u, Presences: []gateway.PresenceUpdate{}, Emoji: []expressions.Emoji{}, Sounds: []expressions.Sound{}, Activities: []integrations.Activity{}}
	var channelIDs []id.ID
	rs, gated, err := b.server(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	if rs != nil {
		r.Server = rs
		if r.Emoji, err = b.expressions.List(ctx); err != nil { // members held at the rules gate too
			return nil, err
		}
		if r.Sounds, err = b.expressions.Sounds(ctx); err != nil {
			return nil, err
		}
		for _, ch := range rs.Channels {
			channelIDs = append(channelIDs, ch.ID)
		}
		memberIDs := make([]id.ID, 0, len(rs.Members))
		for _, m := range rs.Members {
			memberIDs = append(memberIDs, m.User.ID)
			if st := status(m.User.ID); st != gateway.StatusOffline {
				r.Presences = append(r.Presences, gateway.PresenceUpdate{UserID: m.User.ID, Status: st})
			}
		}
		r.Activities = b.integrations.Activities(memberIDs)
	}
	if gated {
		r.DMs, r.ReadStates, r.VoiceStates = []channels.Channel{}, []messages.ReadState{}, []voice.VoiceState{}
		return r, nil
	}
	if r.DMs, err = b.channels.ListDMs(ctx, u.ID); err != nil {
		return nil, err
	}
	for _, dm := range r.DMs {
		channelIDs = append(channelIDs, dm.ID)
	}
	if r.ReadStates, err = b.messages.ReadStates(ctx, u.ID, channelIDs); err != nil {
		return nil, err
	}
	r.VoiceStates = b.voice.States(channelIDs)
	return r, nil
}

// server returns the server as userID sees it, or nil if they are not a
// member (or nobody has registered yet), and whether the rules gate holds
// them.
func (b readyBuilder) server(ctx context.Context, userID id.ID) (*ReadyServer, bool, error) {
	sv, err := b.communities.Server(ctx)
	if errors.Is(err, communities.ErrNotFound) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	m, err := b.communities.PermMember(ctx, sv.ID, userID)
	if errors.Is(err, communities.ErrNotMember) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	rs := &ReadyServer{Server: *sv, Members: []communities.Member{}, Categories: []channels.Category{}}
	if rs.Roles, err = b.communities.Roles(ctx, sv.ID); err != nil {
		return nil, false, err
	}
	if !m.Gated { // a member held at the rules gate sees only the welcome page
		if rs.Members, err = b.communities.Members(ctx, sv.ID); err != nil {
			return nil, false, err
		}
		if rs.Categories, err = b.channels.Categories(ctx, sv.ID); err != nil {
			return nil, false, err
		}
	}
	if rs.Channels, err = b.channels.ListVisible(ctx, userID, sv.ID); err != nil {
		return nil, false, err
	}
	return rs, m.Gated, nil
}

type audience struct {
	communities *communities.Service
	channels    *channels.Service
}

func (a audience) Resolve(ctx context.Context, s events.Scope) ([]id.ID, error) {
	seen := map[id.ID]bool{}
	var out []id.ID
	add := func(ids []id.ID) {
		for _, u := range ids {
			if !seen[u] {
				seen[u] = true
				out = append(out, u)
			}
		}
	}
	if s.ChannelID != 0 {
		v, err := a.channels.Viewers(ctx, s.ChannelID)
		if err != nil && !errors.Is(err, channels.ErrNotFound) {
			return nil, err
		}
		add(v)
	}
	if s.CommunityID != 0 {
		v, err := a.communities.MemberIDs(ctx, s.CommunityID)
		if err != nil {
			return nil, err
		}
		add(v)
	}
	if s.CoMembersOf != 0 {
		v, err := a.communities.CoMemberIDs(ctx, s.CoMembersOf)
		if err != nil {
			return nil, err
		}
		add(v)
	}
	add(s.UserIDs)
	return out, nil
}

// registerEventSchemas puts gateway payload types into the OpenAPI
// document so the generated TypeScript types include them. Huma drops
// component schemas that nothing references, so the document also lists
// them under the x-datrope-gateway-schemas extension.
func registerEventSchemas(api huma.API) {
	doc := api.OpenAPI()
	refs := map[string]any{}
	for _, v := range []any{
		Ready{}, gateway.Hello{}, gateway.PresenceUpdate{}, auth.PublicUser{},
		messages.Message{}, messages.MessageDeleted{}, messages.TypingStart{}, messages.ReactionEvent{}, messages.ThreadUpdate{}, messages.PollUpdate{},
		channels.ChannelDeleted{}, communities.MemberRemoved{}, communities.RoleDeleted{}, communities.Server{},
		channels.Category{}, channels.CategoryDeleted{},
		files.Attachment{}, voice.VoiceState{}, voice.VoiceMove{}, voice.SoundboardPlay{}, expressions.EmojiUpdate{}, expressions.SoundUpdate{},
		integrations.ActivityUpdate{}, music.MusicState{},
	} {
		s := doc.Components.Schemas.Schema(reflect.TypeOf(v), true, "")
		refs[strings.TrimPrefix(s.Ref, "#/components/schemas/")] = map[string]string{"$ref": s.Ref}
	}
	if doc.Extensions == nil {
		doc.Extensions = map[string]any{}
	}
	doc.Extensions["x-datrope-gateway-schemas"] = refs
}
