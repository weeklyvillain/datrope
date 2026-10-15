package voice

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"net/http"
	"slices"
	"time"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

type TeamsRequest struct {
	Teams   int     `json:"teams" minimum:"2" maximum:"8"`
	PerTeam int     `json:"per_team,omitempty" minimum:"0" maximum:"50" doc:"Players per team; 0 or absent splits everyone evenly"`
	UserIDs []id.ID `json:"user_ids" minItems:"2" maxItems:"100" doc:"Who is in the draw; all must be in the call"`
}

// TeamsDraw is a random split of a call into teams, sent to everyone in the call. It is not stored.
type TeamsDraw struct {
	ChannelID id.ID     `json:"channel_id"`
	By        id.ID     `json:"by"`
	Teams     [][]id.ID `json:"teams"`
	Bench     []id.ID   `json:"bench"`
	PerTeam   int       `json:"per_team" doc:"0: an even split"`
	At        time.Time `json:"at"`
}

// CryptoShuffle shuffles in place with crypto/rand (Fisher–Yates).
func CryptoShuffle(xs []id.ID) {
	var b [8]byte
	for i := len(xs) - 1; i > 0; i-- {
		_, _ = rand.Read(b[:])
		j := int(binary.LittleEndian.Uint64(b[:]) % uint64(i+1))
		xs[i], xs[j] = xs[j], xs[i]
	}
}

// Deal shuffles ids and deals them round robin into `teams` teams of at most perTeam (0: no limit); the rest sit out.
func Deal(ids []id.ID, teams, perTeam int, shuffle func([]id.ID)) ([][]id.ID, []id.ID) {
	pool := slices.Clone(ids)
	shuffle(pool)
	n := len(pool)
	if perTeam > 0 && teams*perTeam < n {
		n = teams * perTeam
	}
	out := make([][]id.ID, teams)
	for i := range out {
		out[i] = []id.ID{}
	}
	for i, u := range pool[:n] {
		out[i%teams] = append(out[i%teams], u)
	}
	return out, append([]id.ID{}, pool[n:]...)
}

// DrawTeams splits the chosen people in the caller's call into teams and tells everyone in the call.
func (s *Service) DrawTeams(ctx context.Context, callerID, channelID id.ID, req TeamsRequest) error {
	pool := slices.Compact(slices.Sorted(slices.Values(req.UserIDs)))
	if req.PerTeam > 0 && req.Teams*req.PerTeam > len(pool) {
		return httpx.BadRequest("TOO_FEW_PLAYERS", "not enough people for that many full teams")
	}
	if len(pool) < req.Teams {
		return httpx.BadRequest("TOO_FEW_PLAYERS", "fewer people than teams")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.users[callerID]; p == nil || p.channelID != channelID {
		return httpx.E(http.StatusForbidden, "NOT_IN_CALL", "you are not in this call")
	}
	if !s.teamsLimit.Allow(callerID.String()) {
		return httpx.RateLimited()
	}
	var listeners []id.ID
	for uid, q := range s.users {
		if q.channelID == channelID {
			listeners = append(listeners, uid)
		}
	}
	for _, u := range pool {
		if !slices.Contains(listeners, u) {
			return httpx.BadRequest("NOT_IN_CALL", "someone in the draw is not in the call any more")
		}
	}
	teams, bench := Deal(pool, req.Teams, req.PerTeam, CryptoShuffle)
	s.bus.Publish(events.Event{Type: "VOICE_TEAMS", Data: TeamsDraw{ChannelID: channelID, By: callerID, Teams: teams, Bench: bench,
		PerTeam: req.PerTeam, At: time.Now()}, Scope: events.Scope{UserIDs: listeners}})
	return nil
}
