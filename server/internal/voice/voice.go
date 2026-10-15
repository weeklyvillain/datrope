package voice

import (
	"cmp"
	"context"
	"log/slog"
	"math"
	"net/http"
	"slices"
	"strconv"
	"sync"
	"time"

	lkauth "github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"

	"github.com/datrope/datrope/server/internal/audit"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
	"github.com/datrope/datrope/server/internal/ratelimit"
)

// syncInterval is how often voice state is rebuilt from LiveKit. That
// repairs whatever a lost webhook or a restart got wrong.
const syncInterval = 30 * time.Second

// Channels is what voice needs from channels.
type Channels interface {
	Access(ctx context.Context, userID, channelID id.ID, need perms.Perms) (*channels.Channel, perms.Perms, error)
	Perms(ctx context.Context, userID, channelID id.ID) (perms.Perms, *channels.Channel, error)
}

// Ranks is what voice needs from communities: the role hierarchy.
type Ranks interface {
	Outranks(ctx context.Context, actorID, targetID id.ID) (bool, error)
}

type JoinRequest struct {
	SelfMute bool `json:"self_mute,omitempty" doc:"The client starts muted"`
	SelfDeaf bool `json:"self_deaf,omitempty" doc:"The client starts deafened"`
}

type JoinResponse struct {
	URL   string `json:"url" doc:"LiveKit server to connect to"`
	Token string `json:"token" doc:"LiveKit access token for the channel's room"`
}

type SelfStateRequest struct {
	SelfMute *bool `json:"self_mute,omitempty"`
	SelfDeaf *bool `json:"self_deaf,omitempty"`
}

// VoiceState is one user's presence in voice, as clients see it.
type VoiceState struct {
	UserID     id.ID  `json:"user_id"`
	ChannelID  *id.ID `json:"channel_id,omitempty" doc:"Absent when the user left voice"`
	SelfMute   bool   `json:"self_mute"`
	SelfDeaf   bool   `json:"self_deaf"`
	ServerMute bool   `json:"server_mute" doc:"Muted by a moderator"`
	Camera     bool   `json:"camera"`
	Screen     bool   `json:"screen" doc:"Sharing their screen"`
}

func unavailable(msg string) *httpx.Error {
	return httpx.E(http.StatusServiceUnavailable, "VOICE_UNAVAILABLE", msg)
}

type selfState struct{ mute, deaf bool }

// pendingJoin keeps the flags a client sent with its join request until
// LiveKit reports the user in the room, and a server mute carried over
// from rejoining the same channel.
type pendingJoin struct {
	channelID  id.ID
	self       selfState
	serverMute bool
	moved      bool // a moderator moved them here: they may stay without CONNECT
	at         time.Time
}

// participant is one user in one room. channelID never changes: moving to
// another room makes a new participant.
type participant struct {
	channelID  id.ID
	sid        string // LiveKit participant SID; reports about other SIDs are stale
	joinedAt   int64  // when LiveKit let them in (Unix milliseconds); the newest connection wins
	issued     int64  // when their token was issued (Unix milliseconds; 0 = unknown)
	session    id.ID  // the auth session that joined (0 = unknown)
	addedAt    time.Time
	self       selfState
	serverMute bool
	moved      bool                           // a moderator moved them here: they may stay without CONNECT
	tracks     map[string]livekit.TrackSource // published tracks by track SID
	sources    []livekit.TrackSource          // what LiveKit currently lets them publish
}

func (p *participant) publishing(src livekit.TrackSource) bool {
	for _, s := range p.tracks {
		if s == src {
			return true
		}
	}
	return false
}

func (p *participant) state(userID id.ID) VoiceState {
	ch := p.channelID
	return VoiceState{UserID: userID, ChannelID: &ch, SelfMute: p.self.mute, SelfDeaf: p.self.deaf, ServerMute: p.serverMute,
		Camera: p.publishing(livekit.TrackSource_CAMERA), Screen: p.publishing(livekit.TrackSource_SCREEN_SHARE)}
}

// change is when (in Service.seq order, and by the clock for cleaning up)
// a user's entry last changed.
type change struct {
	seq uint64
	at  time.Time
}

type Service struct {
	active   func() bool // nil: always live; see SetActive
	cfg      Config
	rooms    *Rooms // nil when voice is off
	bus      *events.Bus
	channels Channels
	ranks    Ranks  // nil: no hierarchy checks
	sounds   Sounds // nil until SetSounds

	audit audit.Execer // nil: moderation goes unrecorded (no database)

	soundLimit *ratelimit.Limiter // one soundboard play per 2 s per user

	// mu guards users, pending, moves and changed. It is held while publishing
	// voice events so they reach clients in order.
	mu      sync.Mutex
	users   map[id.ID]*participant
	pending map[id.ID]pendingJoin
	moves   map[id.ID]movePass // a moderator's move, until the moved user joins
	changed map[id.ID]change   // when a user's entry last changed; Sync ignores older snapshots of them
	seq     uint64             // counts changes (clocks can be too coarse to order them)

	poke      chan struct{}       // asks the background loop to reconcile
	resync    chan struct{}       // asks the background loop to re-read LiveKit, then reconcile
	outMu     sync.Mutex          // guards signedOut and revoked (see onEvent)
	signedOut map[id.ID]time.Time // when each user was signed out everywhere
	revoked   map[id.ID]time.Time // when each revoked session was revoked

	ctx    context.Context // cancelled by Close
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func NewService(cfg Config, bus *events.Bus, ch Channels, ranks Ranks) *Service {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Service{
		cfg: cfg, bus: bus, channels: ch, ranks: ranks,
		users: map[id.ID]*participant{}, pending: map[id.ID]pendingJoin{}, moves: map[id.ID]movePass{}, changed: map[id.ID]change{},
		poke: make(chan struct{}, 1), resync: make(chan struct{}, 1), signedOut: map[id.ID]time.Time{}, revoked: map[id.ID]time.Time{},
		ctx: ctx, cancel: cancel, soundLimit: ratelimit.New(30, 1),
	}
	if cfg.Enabled() {
		s.rooms = NewRooms(cfg)
		bus.Subscribe(s.onEvent)
	}
	return s
}

// SetAudit records moderation (moves, disconnects, server mutes) in q's audit log.
func (s *Service) SetAudit(q audit.Execer) { s.audit = q }

// Start follows LiveKit in the background until Close.
func (s *Service) Start() {
	if !s.cfg.Enabled() {
		return
	}
	s.wg.Add(1)
	go s.run()
}

func (s *Service) Close() {
	s.cancel()
	s.wg.Wait()
}

func (s *Service) run() {
	defer s.wg.Done()
	tick := time.NewTicker(syncInterval)
	defer tick.Stop()
	s.refresh(true)
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-tick.C:
			s.refresh(true)
		case <-s.poke:
			s.refresh(false)
		case <-s.resync:
			s.refresh(true)
		}
	}
}

// refresh optionally re-reads LiveKit, then enforces permissions.
func (s *Service) refresh(sync bool) {
	if !s.isActive() {
		return
	}
	if sync {
		if err := s.Sync(s.ctx); err != nil && s.ctx.Err() == nil {
			slog.Error("voice: sync with livekit", "err", err)
		}
	}
	select { // a wake raised while syncing is covered by the pass below
	case <-s.poke:
	default:
	}
	if err := s.Reconcile(s.ctx); err != nil && s.ctx.Err() == nil {
		slog.Error("voice: apply permissions", "err", err)
	}
}

func displayName(u *auth.User) string {
	if u.DisplayName != "" {
		return u.DisplayName
	}
	return u.Username
}

// Join checks the user may connect to a channel's voice and returns a token
// for its LiveKit room (spec section 5.3, steps 1–2).
func (s *Service) Join(ctx context.Context, user *auth.User, sessionID, channelID id.ID, req JoinRequest) (*JoinResponse, error) {
	if !s.cfg.Enabled() {
		return nil, unavailable("voice is not set up on this server")
	}
	c, p, err := s.channels.Access(ctx, user.ID, channelID, 0)
	if err != nil {
		return nil, err
	}
	moved := s.hasMovePass(user.ID, channelID)
	if !p.Has(perms.ConnectVoice) && !moved {
		return nil, httpx.MissingPermission()
	}
	if c.Type != channels.TypeVoice && c.Type != channels.TypeDM {
		return nil, httpx.BadRequest("NOT_VOICE_CHANNEL", "this is not a voice channel")
	}
	if err := s.rooms.Ensure(ctx, channelID); err != nil {
		slog.ErrorContext(ctx, "voice: livekit unreachable", "err", err)
		return nil, unavailable("the voice server is unreachable")
	}
	serverMute := s.prepareJoin(ctx, user.ID, channelID, selfState{mute: req.SelfMute, deaf: req.SelfDeaf}, moved)
	token, err := s.cfg.JoinToken(channelID, user.ID, displayName(user), Sources(p, serverMute),
		Attrs{SessionID: sessionID, SelfMute: req.SelfMute, SelfDeaf: req.SelfDeaf})
	if err != nil {
		return nil, err
	}
	return &JoinResponse{URL: s.cfg.PublicURL, Token: token}, nil
}

// prepareJoin keeps the client's flags until LiveKit reports the user, and
// takes them out of any other channel at once: a user is in one voice
// channel at a time. Rejoining the same channel keeps a server mute.
func (s *Service) prepareJoin(ctx context.Context, userID, channelID id.ID, self selfState, moved bool) (serverMute bool) {
	s.mu.Lock()
	if moved {
		delete(s.moves, userID) // one join per move
	}
	var leave *id.ID
	if p := s.users[userID]; p != nil {
		if p.channelID == channelID {
			serverMute = p.serverMute
		} else {
			delete(s.users, userID)
			s.publishLeftLocked(userID, p.channelID)
			leave = &p.channelID
		}
	}
	s.pending[userID] = pendingJoin{channelID: channelID, self: self, serverMute: serverMute, moved: moved, at: time.Now()}
	s.touchLocked(userID)
	s.mu.Unlock()
	if leave != nil {
		if err := s.rooms.Remove(ctx, *leave, userID); err != nil {
			slog.ErrorContext(ctx, "voice: leave previous channel", "err", err)
		}
	}
	return serverMute
}

func (s *Service) touchLocked(userID id.ID) {
	s.seq++
	s.changed[userID] = change{s.seq, time.Now()}
}

func (s *Service) publishLocked(userID id.ID, p *participant) {
	s.bus.Publish(events.Event{Type: "VOICE_STATE_UPDATE", Data: p.state(userID), Scope: events.Scope{ChannelID: p.channelID}})
}

// publishLeftLocked tells a channel's viewers the user left voice.
func (s *Service) publishLeftLocked(userID, channelID id.ID) {
	s.bus.Publish(events.Event{Type: "VOICE_STATE_UPDATE", Data: VoiceState{UserID: userID}, Scope: events.Scope{ChannelID: channelID}})
}

// seen is a participant as LiveKit reports it.
type seen struct {
	channelID, userID id.ID
	sid               string
	joinedAt          int64 // milliseconds
	issued            int64 // token issue time, milliseconds
	session           id.ID // the auth session that joined
	self              selfState
	tracks            map[string]livekit.TrackSource
	sources           []livekit.TrackSource
}

// joinedMs is when LiveKit let the participant in, in milliseconds.
func joinedMs(p *livekit.ParticipantInfo) int64 {
	if p.GetJoinedAtMs() != 0 {
		return p.GetJoinedAtMs()
	}
	return p.GetJoinedAt() * 1000
}

// issuedOf is when the participant's token was issued, in milliseconds.
func issuedOf(p *livekit.ParticipantInfo) int64 {
	n, _ := strconv.ParseInt(p.GetAttributes()[issuedAttr], 10, 64)
	return n
}

// sessionOf is the auth session that joined (0 if unknown).
func sessionOf(p *livekit.ParticipantInfo) id.ID {
	s, _ := id.Parse(p.GetAttributes()[sessionAttr])
	return s
}

// fromLiveKit reads a participant of a room. Rooms and identities that are
// not Datrope IDs are not ours.
func fromLiveKit(room string, p *livekit.ParticipantInfo) (seen, bool) {
	ch, err1 := id.Parse(room)
	u, err2 := id.Parse(p.GetIdentity())
	if err1 != nil || err2 != nil {
		return seen{}, false
	}
	attrs := p.GetAttributes()
	v := seen{channelID: ch, userID: u, sid: p.GetSid(), joinedAt: joinedMs(p), issued: issuedOf(p), session: sessionOf(p),
		self: selfState{mute: attrs[selfMuteAttr] == "1", deaf: attrs[selfDeafAttr] == "1"}, tracks: map[string]livekit.TrackSource{}}
	for _, t := range p.GetTracks() {
		v.tracks[t.GetSid()] = t.GetSource()
	}
	if perm := p.GetPermission(); perm.GetCanPublish() {
		v.sources = perm.GetCanPublishSources()
		if len(v.sources) == 0 { // "any source": never what we grant, so the next reconcile fixes it
			v.sources = []livekit.TrackSource{livekit.TrackSource_UNKNOWN}
		}
	}
	return v, true
}

// adopt records participants LiveKit reports, oldest first, and removes
// connections that lose to a newer one elsewhere.
func (s *Service) adopt(ctx context.Context, vs []seen) { s.adoptSince(ctx, vs, math.MaxUint64) }

// adoptSince is adopt for a snapshot taken when s.seq was since: users whose
// state changed after that are skipped, as the snapshot is outdated for them.
func (s *Service) adoptSince(ctx context.Context, vs []seen, since uint64) {
	type removal struct{ channelID, userID id.ID }
	var removals []removal
	s.mu.Lock()
	for _, v := range vs {
		if s.changed[v.userID].seq > since {
			continue
		}
		if ch, stale := s.joinedLocked(v); stale {
			removals = append(removals, removal{ch, v.userID})
		}
	}
	s.mu.Unlock()
	for _, r := range removals {
		if err := s.rooms.Remove(ctx, r.channelID, r.userID); err != nil {
			slog.ErrorContext(ctx, "voice: remove older connection", "err", err)
		}
	}
	s.wake()
}

// joinedLocked records that LiveKit has v.userID in a room. If LiveKit has
// them in two rooms, the newer connection wins and the other room's
// channel is returned so the caller can remove them from it.
func (s *Service) joinedLocked(v seen) (remove id.ID, stale bool) {
	old := s.users[v.userID]
	if old != nil && old.sid == v.sid { // known connection: refresh it
		cam, scr := old.publishing(livekit.TrackSource_CAMERA), old.publishing(livekit.TrackSource_SCREEN_SHARE)
		old.tracks, old.sources, old.issued = v.tracks, v.sources, v.issued
		if cam != old.publishing(livekit.TrackSource_CAMERA) || scr != old.publishing(livekit.TrackSource_SCREEN_SHARE) {
			s.publishLocked(v.userID, old)
		}
		return 0, false
	}
	if old != nil && v.joinedAt < old.joinedAt { // a late report about an older connection
		return v.channelID, old.channelID != v.channelID
	}
	// With no earlier entry or pending join (say, after a restart) the
	// flags come from the participant's attributes.
	p := &participant{channelID: v.channelID, sid: v.sid, joinedAt: v.joinedAt, issued: v.issued, session: v.session,
		addedAt: time.Now(), self: v.self, tracks: v.tracks, sources: v.sources}
	reconnected := old != nil && old.channelID == v.channelID
	if reconnected {
		p.self, p.serverMute, p.moved = old.self, old.serverMute, old.moved
	} else if old != nil {
		s.publishLeftLocked(v.userID, old.channelID)
		remove, stale = old.channelID, true
	}
	if pj, ok := s.pending[v.userID]; ok && pj.channelID == v.channelID {
		p.self = pj.self
		p.moved = p.moved || pj.moved
		if !reconnected { // the old connection was reported gone first
			p.serverMute = pj.serverMute
		}
		delete(s.pending, v.userID)
	}
	s.users[v.userID] = p
	s.touchLocked(v.userID)
	s.publishLocked(v.userID, p)
	return remove, stale
}

func (s *Service) leftLocked(userID id.ID, sid string) {
	p := s.users[userID]
	if p == nil || p.sid != sid {
		return // about an older connection
	}
	delete(s.users, userID)
	s.touchLocked(userID)
	s.publishLeftLocked(userID, p.channelID)
}

func (s *Service) trackLocked(userID id.ID, sid string, t *livekit.TrackInfo, published bool) {
	p := s.users[userID]
	if p == nil || p.sid != sid || t == nil {
		return
	}
	cam, scr := p.publishing(livekit.TrackSource_CAMERA), p.publishing(livekit.TrackSource_SCREEN_SHARE)
	if published {
		p.tracks[t.GetSid()] = t.GetSource()
	} else {
		delete(p.tracks, t.GetSid())
	}
	if cam != p.publishing(livekit.TrackSource_CAMERA) || scr != p.publishing(livekit.TrackSource_SCREEN_SHARE) {
		s.publishLocked(userID, p)
	}
}

// WebhookHandler receives LiveKit's webhooks (spec section 5.3, step 4).
// They are signed with the API secret; anything else is refused.
func (s *Service) WebhookHandler() http.Handler {
	keys := lkauth.NewSimpleKeyProvider(s.cfg.APIKey, s.cfg.APISecret)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		ev, err := webhook.ReceiveWebhookEvent(r, keys)
		if err != nil {
			httpx.WriteHTTPError(w, r, httpx.Unauthorized())
			return
		}
		s.handle(r.Context(), ev)
		w.WriteHeader(http.StatusNoContent)
	})
}

func (s *Service) handle(ctx context.Context, ev *livekit.WebhookEvent) {
	if ev.GetRoom() == nil || ev.GetParticipant() == nil {
		return // room events: participants report themselves
	}
	v, ok := fromLiveKit(ev.GetRoom().GetName(), ev.GetParticipant())
	if !ok {
		return
	}
	switch ev.GetEvent() {
	case webhook.EventParticipantJoined:
		s.adopt(ctx, []seen{v})
	case webhook.EventParticipantLeft, webhook.EventParticipantConnectionAborted:
		s.mu.Lock()
		s.leftLocked(v.userID, v.sid)
		s.mu.Unlock()
	case webhook.EventTrackPublished, webhook.EventTrackUnpublished:
		// Only for known connections: a late track event must not bring
		// back someone who left. Sync picks up anything missed.
		s.mu.Lock()
		s.trackLocked(v.userID, v.sid, ev.GetTrack(), ev.GetEvent() == webhook.EventTrackPublished)
		s.mu.Unlock()
	}
}

// Sync rebuilds voice state from LiveKit. Webhooks are the fast path; this
// repairs missed ones and restarts.
func (s *Service) Sync(ctx context.Context) error {
	if !s.cfg.Enabled() {
		return nil
	}
	started := time.Now()
	s.mu.Lock()
	since := s.seq
	s.mu.Unlock()
	names, err := s.rooms.List(ctx)
	if err != nil {
		return err
	}
	var all []seen
	for _, name := range names {
		ps, err := s.rooms.Participants(ctx, name)
		if err != nil {
			return err
		}
		for _, p := range ps {
			if v, ok := fromLiveKit(name, p); ok {
				all = append(all, v)
			}
		}
	}
	slices.SortStableFunc(all, func(a, b seen) int { return cmp.Compare(a.joinedAt, b.joinedAt) })
	live := make(map[string]bool, len(all))
	for _, v := range all {
		live[v.sid] = true
	}
	s.mu.Lock()
	for userID, p := range s.users {
		// Entries added after we asked LiveKit may not be in its answer yet.
		if !live[p.sid] && p.addedAt.Before(started) {
			delete(s.users, userID)
			s.touchLocked(userID)
			s.publishLeftLocked(userID, p.channelID)
		}
	}
	for userID, c := range s.changed {
		if time.Since(c.at) > 5*time.Minute { // no snapshot is that old
			delete(s.changed, userID)
		}
	}
	for userID, pj := range s.pending {
		if time.Since(pj.at) > TokenTTL { // their token has expired unused
			delete(s.pending, userID)
		}
	}
	s.mu.Unlock()
	s.adoptSince(ctx, all, since)
	return nil
}

// SetSelf records a user's own mute and deafen flags (their client does
// the muting; the server only tells others). They are also kept in the
// participant's LiveKit attributes for a restarted server to read.
func (s *Service) SetSelf(ctx context.Context, userID id.ID, req SelfStateRequest) error {
	apply := func(f *selfState) {
		if req.SelfMute != nil {
			f.mute = *req.SelfMute
		}
		if req.SelfDeaf != nil {
			f.deaf = *req.SelfDeaf
		}
	}
	s.mu.Lock()
	p, connected := s.users[userID]
	pj, connecting := s.pending[userID] // still connecting, maybe to another channel
	if !connected && !connecting {
		s.mu.Unlock()
		return httpx.E(http.StatusConflict, "NOT_IN_VOICE", "you are not in a voice channel")
	}
	if connecting {
		apply(&pj.self)
		s.pending[userID] = pj
	}
	var channelID id.ID
	var self selfState
	if connected {
		apply(&p.self)
		s.publishLocked(userID, p)
		channelID, self = p.channelID, p.self
	}
	s.mu.Unlock()
	if connected {
		if err := s.rooms.SetAttributes(ctx, channelID, userID, selfAttrs(self.mute, self.deaf)); err != nil {
			slog.ErrorContext(ctx, "voice: keep self flags in livekit", "err", err)
		}
	}
	return nil
}

// States lists who is in voice in the given channels.
func (s *Service) States(channelIDs []id.ID) []VoiceState {
	want := make(map[id.ID]bool, len(channelIDs))
	for _, c := range channelIDs {
		want[c] = true
	}
	out := []VoiceState{}
	s.mu.Lock()
	for userID, p := range s.users {
		if want[p.channelID] {
			out = append(out, p.state(userID))
		}
	}
	s.mu.Unlock()
	slices.SortFunc(out, func(a, b VoiceState) int { return cmp.Compare(a.UserID, b.UserID) })
	return out
}

// Participants counts the people in voice channels.
func (s *Service) Participants() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.users)
}
