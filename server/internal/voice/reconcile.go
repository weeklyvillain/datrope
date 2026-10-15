package voice

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/datrope/datrope/server/internal/audit"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type ServerMuteRequest struct {
	Muted bool `json:"muted"`
}

type MoveRequest struct {
	ChannelID id.ID `json:"channel_id"`
}

// movePassTTL is how long a moved member has to re-join in the new channel.
const movePassTTL = 2 * time.Minute

// movePass lets a moved member join a channel they could not connect to.
type movePass struct {
	channelID id.ID
	until     time.Time
}

// hasMovePass reports whether a moderator just moved the user to the channel.
func (s *Service) hasMovePass(userID, channelID id.ID) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, ok := s.moves[userID]
	return ok && m.channelID == channelID && time.Now().Before(m.until)
}

// VoiceMove asks a user's clients to re-join voice in another channel.
// Only that user receives it.
type VoiceMove struct {
	ChannelID id.ID `json:"channel_id"`
}

// permissionEvents can change what someone may do in voice.
var permissionEvents = map[string]bool{
	"MEMBER_REMOVE": true, "MEMBER_UPDATE": true, "ROLE_UPDATE": true, "ROLE_DELETE": true,
	"CHANNEL_UPDATE": true, "CHANNEL_DELETE": true, "SERVER_UPDATE": true, // the rules gate
}

// revocationTTL is how long a sign-out or a revoked session is enforced: a
// token issued before it can be used to connect for TokenTTL, and Sync can
// take up to two rounds to notice that connection.
const revocationTTL = TokenTTL + 2*syncInterval

// onEvent runs inside bus.Publish: it must not block or call LiveKit. It
// only takes outMu, never mu (voice publishes while holding mu).
func (s *Service) onEvent(e events.Event) {
	switch {
	case permissionEvents[e.Type]:
		s.wake()
	case e.Type == events.SessionsRevoked:
		d, ok := e.Data.(events.SessionsRevokedData)
		if !ok {
			return
		}
		s.outMu.Lock()
		if d.SessionIDs == nil { // signed out everywhere
			s.signedOut[d.UserID] = time.Now()
		}
		for _, sess := range d.SessionIDs {
			s.revoked[sess] = time.Now()
		}
		s.outMu.Unlock()
		s.wake()
	}
}

// wake asks the background loop to reconcile soon.
func (s *Service) wake() {
	select {
	case s.poke <- struct{}{}:
	default: // one is already due
	}
}

// Reconcile applies everyone's current permissions to their LiveKit
// connection (spec section 5.3, step 5). Users who may no longer connect
// are removed; everyone else may publish exactly what their permissions
// and any server mute allow.
func (s *Service) Reconcile(ctx context.Context) error {
	// A revocation stays in force for revocationTTL: a token issued before
	// it can still be used to connect until TokenTTL.
	s.outMu.Lock()
	out := make(map[id.ID]time.Time, len(s.signedOut))
	for u, at := range s.signedOut {
		if time.Since(at) > revocationTTL {
			delete(s.signedOut, u)
			continue
		}
		out[u] = at
	}
	revoked := make(map[id.ID]bool, len(s.revoked))
	for sess, at := range s.revoked {
		if time.Since(at) > revocationTTL {
			delete(s.revoked, sess)
			continue
		}
		revoked[sess] = true
	}
	s.outMu.Unlock()

	s.mu.Lock()
	for u, at := range out {
		if pj, ok := s.pending[u]; ok && !pj.at.After(at) {
			delete(s.pending, u) // a join from before the sign-out is void
		}
	}
	users := make([]id.ID, 0, len(s.users))
	for u := range s.users {
		users = append(users, u)
	}
	s.mu.Unlock()

	deleted := map[id.ID]bool{}
	var errs []error
	for _, u := range users {
		errs = append(errs, s.reconcileUser(ctx, u, out[u], revoked, deleted))
	}
	return errors.Join(errs...)
}

// reconcileUser brings one user's connection in line with their
// permissions; a connection whose token was issued at or before revoked
// (the zero time: never), or that joined from a session in sessions, is
// removed whatever its permissions. deleted collects the rooms of deleted
// channels already closed.
func (s *Service) reconcileUser(ctx context.Context, userID id.ID, revoked time.Time, sessions, deleted map[id.ID]bool) error {
	for {
		s.mu.Lock()
		p := s.users[userID]
		if p == nil {
			s.mu.Unlock()
			return nil
		}
		channelID, sid, serverMute, have, issued, session, moved := p.channelID, p.sid, p.serverMute, p.sources, p.issued, p.session, p.moved
		s.mu.Unlock()

		allowed, c, err := s.channels.Perms(ctx, userID, channelID)
		gone := errors.Is(err, channels.ErrNotFound)
		if err != nil && !gone {
			return err
		}
		if (!revoked.IsZero() && issued <= revoked.UnixMilli()) || sessions[session] || gone ||
			!allowed.Has(perms.ViewChannel) || (!allowed.Has(perms.ConnectVoice) && !moved) {
			err := s.disconnect(ctx, userID, channelID, sid)
			if gone && !deleted[channelID] { // the channel was deleted: close its room
				deleted[channelID] = true
				err = errors.Join(err, s.rooms.Delete(ctx, channelID))
			}
			return err
		}
		want, err := s.sourcesFor(ctx, c, allowed, serverMute)
		if err != nil {
			return err
		}
		if slices.Equal(want, have) {
			return nil
		}
		if err := s.rooms.SetSources(ctx, channelID, userID, want); err != nil {
			return err
		}
		s.mu.Lock()
		p = s.users[userID]
		if p == nil || p.sid != sid {
			s.mu.Unlock()
			return nil
		}
		p.sources = want
		again := p.serverMute != serverMute // changed while we talked to LiveKit
		s.mu.Unlock()
		if !again {
			return nil
		}
	}
}

// disconnect takes one connection of a user out of a channel's voice: out
// of the LiveKit room and out of voice state. It does nothing if the user
// has since reconnected (another sid).
func (s *Service) disconnect(ctx context.Context, userID, channelID id.ID, sid string) error {
	s.mu.Lock()
	p := s.users[userID]
	if p == nil || p.channelID != channelID || p.sid != sid {
		s.mu.Unlock()
		return nil
	}
	delete(s.users, userID)
	s.touchLocked(userID)
	s.publishLeftLocked(userID, channelID)
	s.mu.Unlock()
	return s.rooms.Remove(ctx, channelID, userID)
}

// inVoice returns the channel and connection a user is in, after checking
// the caller holds need there and, acting on someone else, outranks them.
func (s *Service) inVoice(ctx context.Context, callerID, userID id.ID, need perms.Perms) (ch *channels.Channel, sid string, err error) {
	var channelID id.ID
	s.mu.Lock()
	p := s.users[userID]
	if p != nil {
		channelID, sid = p.channelID, p.sid
	}
	s.mu.Unlock()
	if p == nil {
		return nil, "", httpx.NotFound("voice member")
	}
	ch, _, err = s.channels.Access(ctx, callerID, channelID, need)
	if err != nil {
		return nil, "", err
	}
	if callerID != userID && s.ranks != nil {
		ok, err := s.ranks.Outranks(ctx, callerID, userID)
		if err != nil {
			return nil, "", err
		}
		if !ok {
			return nil, "", httpx.MissingPermission()
		}
	}
	return ch, sid, nil
}

// record adds an audit log entry about a member in voice.
func (s *Service) record(ctx context.Context, action audit.Action, userID id.ID, d audit.LogDetails) error {
	if s.audit == nil {
		return nil
	}
	return audit.Record(ctx, s.audit, action, userID, d)
}

// SetServerMute mutes or unmutes a member's microphone for as long as they
// stay in their channel (MUTE_MEMBERS).
func (s *Service) SetServerMute(ctx context.Context, callerID, userID id.ID, muted bool) error {
	ch, sid, err := s.inVoice(ctx, callerID, userID, perms.MuteMembers)
	if err != nil {
		return err
	}
	channelID := ch.ID
	changed := false
	s.mu.Lock()
	if p := s.users[userID]; p != nil && p.channelID == channelID && p.sid == sid && p.serverMute != muted {
		p.serverMute = muted
		s.publishLocked(userID, p)
		changed = true
	}
	if pj, ok := s.pending[userID]; ok && pj.channelID == channelID { // a rejoin under way keeps this
		pj.serverMute = muted
		s.pending[userID] = pj
	}
	s.mu.Unlock()
	if err := s.reconcileUser(ctx, userID, time.Time{}, nil, map[id.ID]bool{}); err != nil {
		return err
	}
	if !changed {
		return nil
	}
	action := audit.VoiceUnmute
	if muted {
		action = audit.VoiceMute
	}
	return s.record(ctx, action, userID, audit.LogDetails{Channel: &audit.LogRef{ID: ch.ID, Name: ch.Name}})
}

// Disconnect takes a member out of voice (MOVE_MEMBERS); anyone may
// disconnect themselves.
func (s *Service) Disconnect(ctx context.Context, callerID, userID id.ID) error {
	need := perms.MoveMembers
	if callerID == userID {
		need = 0
	}
	ch, sid, err := s.inVoice(ctx, callerID, userID, need)
	if err != nil {
		return err
	}
	if err := s.disconnect(ctx, userID, ch.ID, sid); err != nil {
		return err
	}
	if callerID == userID {
		return nil
	}
	return s.record(ctx, audit.VoiceDisconnect, userID, audit.LogDetails{Channel: &audit.LogRef{ID: ch.ID, Name: ch.Name}})
}

// Move sends a member to another voice channel (MOVE_MEMBERS in both).
// LiveKit's open-source server cannot move participants, so the member's
// clients are told to re-join there. The member must be able to see the
// channel but not to connect to it: the move lets them in and they may stay
// until they leave.
func (s *Service) Move(ctx context.Context, callerID, userID, to id.ID) error {
	fromCh, _, err := s.inVoice(ctx, callerID, userID, perms.MoveMembers)
	if err != nil {
		return err
	}
	from := fromCh.ID
	c, _, err := s.channels.Access(ctx, callerID, to, perms.MoveMembers)
	if err != nil {
		return err
	}
	if c.Type != channels.TypeVoice {
		return httpx.BadRequest("NOT_VOICE_CHANNEL", "members can only be moved to voice channels")
	}
	if from == to {
		return nil
	}
	theirs, _, err := s.channels.Perms(ctx, userID, to)
	if errors.Is(err, channels.ErrNotFound) {
		return httpx.NotFound("channel")
	}
	if err != nil {
		return err
	}
	if !theirs.Has(perms.ViewChannel) {
		return httpx.E(http.StatusForbidden, "MISSING_PERMISSION", "that member cannot see that channel")
	}
	s.mu.Lock()
	s.moves[userID] = movePass{channelID: to, until: time.Now().Add(movePassTTL)}
	s.mu.Unlock()
	s.bus.Publish(events.Event{Type: "VOICE_MOVE", Data: VoiceMove{ChannelID: to}, Scope: events.Scope{UserIDs: []id.ID{userID}}})
	return s.record(ctx, audit.VoiceMove, userID, audit.LogDetails{
		From: &audit.LogRef{ID: fromCh.ID, Name: fromCh.Name}, To: &audit.LogRef{ID: c.ID, Name: c.Name},
	})
}
