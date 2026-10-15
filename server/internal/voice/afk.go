package voice

import (
	"context"
	"net/http"
	"time"

	"github.com/livekit/protocol/livekit"

	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// AFKLookup finds a community's AFK voice channel (communities.Service).
type AFKLookup interface {
	AFKChannel(ctx context.Context, communityID id.ID) (*id.ID, error)
}

func (s *Service) SetAFK(a AFKLookup) { s.afk = a }

// isAFK reports whether c is its server's AFK channel.
func (s *Service) isAFK(ctx context.Context, c *channels.Channel) (bool, error) {
	if s.afk == nil || c.CommunityID == nil || c.Type != channels.TypeVoice {
		return false, nil
	}
	afk, err := s.afk.AFKChannel(ctx, *c.CommunityID)
	return err == nil && afk != nil && *afk == c.ID, err
}

// sourcesFor is what someone may publish in c: nothing in the AFK channel, else what their permissions allow.
func (s *Service) sourcesFor(ctx context.Context, c *channels.Channel, p perms.Perms, serverMute bool) ([]livekit.TrackSource, error) {
	afk, err := s.isAFK(ctx, c)
	if err != nil {
		return nil, err
	}
	if afk {
		return []livekit.TrackSource{}, nil
	}
	return Sources(p, serverMute), nil
}

// GoAFK moves the caller from their voice channel to the server's AFK channel (their client saw them idle).
// It gives the same one-join pass a moderator's move does, so CONNECT is not needed there.
func (s *Service) GoAFK(ctx context.Context, userID id.ID) error {
	s.mu.Lock()
	p := s.users[userID]
	var from id.ID
	if p != nil {
		from = p.channelID
	}
	s.mu.Unlock()
	if p == nil {
		return httpx.E(http.StatusNotFound, "NOT_FOUND", "you are not in a voice call")
	}
	c, _, err := s.channels.Access(ctx, userID, from, 0)
	if err != nil {
		return err
	}
	if c.CommunityID == nil || s.afk == nil {
		return httpx.E(http.StatusConflict, "AFK_NOT_SET", "this server has no AFK channel")
	}
	to, err := s.afk.AFKChannel(ctx, *c.CommunityID)
	if err != nil {
		return err
	}
	if to == nil {
		return httpx.E(http.StatusConflict, "AFK_NOT_SET", "this server has no AFK channel")
	}
	if *to == from {
		return nil
	}
	theirs, _, err := s.channels.Perms(ctx, userID, *to)
	if err != nil {
		return err
	}
	if !theirs.Has(perms.ViewChannel) {
		return httpx.E(http.StatusForbidden, "MISSING_PERMISSION", "you cannot see the AFK channel")
	}
	s.mu.Lock()
	s.moves[userID] = movePass{channelID: *to, until: time.Now().Add(movePassTTL)}
	s.mu.Unlock()
	s.bus.Publish(events.Event{Type: "VOICE_MOVE", Data: VoiceMove{ChannelID: *to}, Scope: events.Scope{UserIDs: []id.ID{userID}}})
	return nil
}
