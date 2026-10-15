package voice

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// Sounds is what voice needs from expressions.
type Sounds interface {
	SoundExists(ctx context.Context, soundID id.ID) (bool, error)
}

func (s *Service) SetSounds(x Sounds) { s.sounds = x }

// SoundboardPlay tells a call's participants to play a sound.
type SoundboardPlay struct {
	ChannelID id.ID `json:"channel_id"`
	UserID    id.ID `json:"user_id"`
	SoundID   id.ID `json:"sound_id"`
}

type PlaySoundRequest struct {
	SoundID id.ID `json:"sound_id"`
}

// PlaySound tells everyone in the caller's call to play a sound.
func (s *Service) PlaySound(ctx context.Context, userID, soundID id.ID) error {
	s.mu.Lock()
	p := s.users[userID]
	var channelID id.ID
	var serverMute bool
	if p != nil {
		channelID, serverMute = p.channelID, p.serverMute
	}
	s.mu.Unlock()
	if p == nil {
		return httpx.E(http.StatusNotFound, "NOT_FOUND", "you are not in a voice call")
	}
	c, _, err := s.channels.Access(ctx, userID, channelID, perms.UseSoundboard|perms.Speak)
	if err != nil {
		return err
	}
	if afk, err := s.isAFK(ctx, c); err != nil {
		return err
	} else if afk {
		return httpx.E(http.StatusForbidden, "AFK_CHANNEL", "the AFK channel is silent")
	}
	if serverMute {
		return httpx.E(http.StatusForbidden, "SERVER_MUTED", "a moderator muted you")
	}
	if s.sounds == nil {
		return httpx.NotFound("sound")
	}
	ok, err := s.sounds.SoundExists(ctx, soundID)
	if err != nil {
		return err
	}
	if !ok {
		return httpx.NotFound("sound")
	}
	if !s.soundLimit.Allow(userID.String()) {
		return httpx.RateLimited()
	}
	s.mu.Lock()
	var listeners []id.ID
	for uid, q := range s.users {
		if q.channelID == channelID {
			listeners = append(listeners, uid)
		}
	}
	s.bus.Publish(events.Event{Type: "SOUNDBOARD_PLAY", Data: SoundboardPlay{ChannelID: channelID, UserID: userID, SoundID: soundID},
		Scope: events.Scope{UserIDs: listeners}})
	s.mu.Unlock()
	return nil
}

func registerSoundboard(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	huma.Register(api, op("play-sound", http.MethodPost, "/api/voice/soundboard", http.StatusNoContent),
		func(ctx context.Context, in *struct{ Body PlaySoundRequest }) (*struct{}, error) {
			return nil, s.PlaySound(ctx, auth.Current(ctx).User.ID, in.Body.SoundID)
		})
}
