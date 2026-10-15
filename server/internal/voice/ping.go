package voice

import (
	"context"
	"net/http"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

// VoicePing is someone's round trip to the voice server, for the others in their call.
type VoicePing struct {
	ChannelID id.ID `json:"channel_id"`
	UserID    id.ID `json:"user_id"`
	RttMs     int   `json:"rtt_ms"`
}

type PingRequest struct {
	RttMs int `json:"rtt_ms" minimum:"0" maximum:"10000"`
}

// Ping tells the others in the caller's call how long the caller's round trip to the voice server is.
// Clients send it every few seconds; it is not stored.
func (s *Service) Ping(ctx context.Context, userID id.ID, rttMs int) error {
	if !s.pingLimit.Allow(userID.String()) {
		return httpx.RateLimited()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.users[userID]
	if p == nil {
		return httpx.E(http.StatusNotFound, "NOT_FOUND", "you are not in a voice call")
	}
	var others []id.ID
	for uid, q := range s.users {
		if q.channelID == p.channelID && uid != userID {
			others = append(others, uid)
		}
	}
	if len(others) > 0 {
		s.bus.Publish(events.Event{Type: "VOICE_PING", Data: VoicePing{ChannelID: p.channelID, UserID: userID, RttMs: rttMs},
			Scope: events.Scope{UserIDs: others}})
	}
	return nil
}
