// Package watch lets the people in a voice channel watch a YouTube video or a
// Twitch stream together: the server keeps what is on and where it is, and
// every client keeps its own player in step.
package watch

import (
	"context"
	"errors"
	"math"
	"slices"
	"sync"
	"time"

	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/linkpreview"
	"github.com/datrope/datrope/server/internal/perms"
	"github.com/datrope/datrope/server/internal/voice"
)

// WatchState is what a voice channel watches and where playback is.
type WatchState struct {
	ChannelID  id.ID   `json:"channel_id"`
	URL        string  `json:"url" doc:"The canonical link"`
	Kind       string  `json:"kind" enum:"youtube,twitch_live,twitch_vod"`
	VideoID    string  `json:"video_id" doc:"The YouTube video ID, the Twitch login, or the Twitch VOD ID"`
	Title      string  `json:"title,omitempty" doc:"Filled in shortly after starting, when the site has one"`
	Paused     bool    `json:"paused"`
	Position   float64 `json:"position" doc:"Seconds into the video at updated_at; always 0 for a live stream"`
	UpdatedAt  int64   `json:"updated_at" doc:"Server time (Unix ms) of position"`
	StartedBy  id.ID   `json:"started_by"`
	LastActor  id.ID   `json:"last_actor"`
	LastAction string  `json:"last_action" enum:"start,play,pause,seek"`
	Seq        int64   `json:"seq" doc:"Changes with every start, play, pause and seek; buffering reports name the seq they answer"`
	Waiting    []id.ID `json:"waiting" nullable:"false" doc:"Viewers the room waits for while their players load; the position holds while any are listed"`
}

// WatchUpdate is a channel's watch as the WATCH_UPDATE event and the REST responses carry it.
type WatchUpdate struct {
	ChannelID id.ID       `json:"channel_id"`
	State     *WatchState `json:"state,omitempty" doc:"Absent when nothing is on"`
	ServerNow int64       `json:"server_now" doc:"Server time (Unix ms) when this was sent, to work out the position with"`
}

// Channels is what this package needs from channels.
type Channels interface {
	Access(ctx context.Context, userID, channelID id.ID, need perms.Perms) (*channels.Channel, perms.Perms, error)
}

// Voice is what this package needs from voice: who is in which channel.
type Voice interface {
	States(channelIDs []id.ID) []voice.VoiceState
}

// Titles looks up a link's title (linkpreview.Service).
type Titles interface {
	Get(ctx context.Context, rawURL string) (*linkpreview.Preview, error)
}

var (
	ErrNotInVoice     = errors.New("watch: not in the voice channel")
	ErrNothingPlaying = errors.New("watch: nothing is on")
	ErrNotSeekable    = errors.New("watch: a live stream cannot seek")
)

const titleTimeout = 5 * time.Second

const (
	// MaxWait is how long the room waits for one viewer before playing on without them.
	MaxWait = 10 * time.Second
	// ExcuseFor is how long a viewer the room gave up on must stay loaded before it waits for them again.
	ExcuseFor = 30 * time.Second
)

// barrier is what a channel's watch keeps about who it waits for, beside its WatchState.
type barrier struct {
	since  map[id.ID]int64 // when each viewer in Waiting entered it (ms)
	waited map[id.ID]int64 // ms each viewer already made the room wait since the last user action
	stop   func()          // cancels the pending expiry; nil when none
}

func newBarrier() *barrier {
	return &barrier{since: map[id.ID]int64{}, waited: map[id.ID]int64{}}
}

func (b *barrier) cancel() {
	if b.stop != nil {
		b.stop()
		b.stop = nil
	}
}

// person is a viewer known to have a player open in a channel's call: they have reported on it.
// It outlives each watch, so someone in the call without the watch open is never waited for.
type person struct {
	excused bool  // the room gave up on them; not waited for until ready ExcuseFor
	readyAt int64 // when they last became ready (ms); 0 since a stall or being excused
}

type Service struct {
	bus      *events.Bus
	channels Channels
	voice    Voice
	titles   Titles // nil: no titles
	now      func() time.Time
	// afterFunc is time.AfterFunc; tests replace it.
	afterFunc func(d time.Duration, f func()) (stop func())

	// pub serialises a change and its publish, so updates go out in the order they happened.
	// Never taken in onEvent, which runs under voice's lock.
	pub sync.Mutex

	mu     sync.Mutex
	states map[id.ID]*WatchState
	bars   map[id.ID]*barrier          // beside states, same keys
	people map[id.ID]map[id.ID]*person // by channel, then user; pruned to who is in the call
	closed bool                        // guarded by mu; no new background work once set

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func NewService(bus *events.Bus, ch Channels, v Voice) *Service {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Service{bus: bus, channels: ch, voice: v, now: time.Now, states: map[id.ID]*WatchState{}, bars: map[id.ID]*barrier{}, people: map[id.ID]map[id.ID]*person{}, ctx: ctx, cancel: cancel,
		afterFunc: func(d time.Duration, f func()) func() { t := time.AfterFunc(d, f); return func() { t.Stop() } }}
	bus.Subscribe(s.onEvent)
	return s
}

func (s *Service) SetTitles(t Titles) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.titles = t
}

func (s *Service) Close() {
	s.mu.Lock()
	s.closed = true
	for _, b := range s.bars {
		b.cancel()
	}
	s.mu.Unlock()
	s.cancel()
	s.wg.Wait()
}

// at is where playback is at server time now (ms).
func (st *WatchState) at(now int64) float64 {
	if st.Paused || st.Kind == KindTwitchLive || len(st.Waiting) > 0 {
		return st.Position
	}
	return st.Position + float64(now-st.UpdatedAt)/1000
}

// Get is the channel's watch now.
func (s *Service) Get(channelID id.ID) WatchUpdate {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.updateLocked(channelID)
}

func (s *Service) updateLocked(channelID id.ID) WatchUpdate {
	u := WatchUpdate{ChannelID: channelID, ServerNow: s.now().UnixMilli()}
	if st := s.states[channelID]; st != nil {
		c := *st
		c.Waiting = slices.Clone(st.Waiting)
		u.State = &c
	}
	return u
}

func (s *Service) publish(u WatchUpdate) {
	s.bus.Publish(events.Event{Type: "WATCH_UPDATE", Data: u, Scope: events.Scope{ChannelID: u.ChannelID}})
}

// viewers is who is in the channel's call. Never call it under mu: voice publishes under its own lock into onEvent, which takes mu.
func (s *Service) viewers(channelID id.ID) []id.ID {
	var out []id.ID
	for _, v := range s.voice.States([]id.ID{channelID}) {
		out = append(out, v.UserID)
	}
	return out
}

func (s *Service) inChannel(userID, channelID id.ID) bool {
	return slices.Contains(s.viewers(channelID), userID)
}

// personLocked is u's entry in ch, made if new: u has a player open.
func (s *Service) personLocked(channelID, userID id.ID) *person {
	ps := s.people[channelID]
	if ps == nil {
		ps = map[id.ID]*person{}
		s.people[channelID] = ps
	}
	p := ps[userID]
	if p == nil {
		p = &person{}
		ps[userID] = p
	}
	return p
}

// countsLocked says whether the room waits for u: they have a player open and are not excused,
// or were excused but have been ready ExcuseFor since.
func (s *Service) countsLocked(channelID, userID id.ID, now int64) bool {
	p := s.people[channelID][userID]
	switch {
	case p == nil:
		return false
	case !p.excused:
		return true
	case p.readyAt > 0 && now-p.readyAt >= ExcuseFor.Milliseconds():
		p.excused = false
		return true
	}
	return false
}

// pruneLocked forgets the players of anyone no longer in the call.
func (s *Service) pruneLocked(channelID id.ID, viewers []id.ID) {
	for u := range s.people[channelID] {
		if !slices.Contains(viewers, u) {
			delete(s.people[channelID], u)
		}
	}
	if len(s.people[channelID]) == 0 {
		delete(s.people, channelID)
	}
}

// setWaitingLocked replaces who the room waits for, folding the position first so the clock stops or restarts at now.
func (s *Service) setWaitingLocked(st *WatchState, b *barrier, waiting []id.ID, now int64) {
	st.Position, st.UpdatedAt = st.at(now), now
	st.Waiting = waiting
	for u, t := range b.since {
		if !slices.Contains(waiting, u) {
			b.waited[u] += now - t
			delete(b.since, u)
		}
	}
	for _, u := range waiting {
		if _, ok := b.since[u]; !ok {
			b.since[u] = now
		}
	}
	s.scheduleLocked(st.ChannelID, b, now)
}

// holdLocked starts a new wait after a user action: for every counted viewer, or nobody while paused or live.
func (s *Service) holdLocked(st *WatchState, b *barrier, viewers []id.ID, now int64) {
	waiting := []id.ID{}
	if !st.Paused && st.Kind != KindTwitchLive {
		for _, u := range viewers {
			if s.countsLocked(st.ChannelID, u, now) {
				waiting = append(waiting, u)
			}
		}
	}
	clear(b.since) // everyone's MaxWait starts over
	clear(b.waited)
	s.setWaitingLocked(st, b, waiting, now)
}

// scheduleLocked arms the expiry for the first viewer to use up their MaxWait.
func (s *Service) scheduleLocked(channelID id.ID, b *barrier, now int64) {
	b.cancel()
	if len(b.since) == 0 || s.closed {
		return
	}
	first := int64(math.MaxInt64)
	for u, t := range b.since {
		first = min(first, t-b.waited[u])
	}
	d := time.Duration(first+MaxWait.Milliseconds()-now) * time.Millisecond
	b.stop = s.afterFunc(max(d, 0), func() { s.expire(channelID) })
}

// endLocked forgets the channel's watch.
func (s *Service) endLocked(channelID id.ID) {
	if b := s.bars[channelID]; b != nil {
		b.cancel()
	}
	delete(s.bars, channelID)
	delete(s.states, channelID)
}

// expire plays on without the viewers the room has waited MaxWait for, and excuses them.
func (s *Service) expire(channelID id.ID) {
	s.pub.Lock()
	defer s.pub.Unlock()
	s.mu.Lock()
	st, b := s.states[channelID], s.bars[channelID]
	if st == nil || b == nil || s.closed {
		s.mu.Unlock()
		return
	}
	now := s.now().UnixMilli()
	waiting := []id.ID{}
	for _, u := range st.Waiting {
		if now-b.since[u]+b.waited[u] >= MaxWait.Milliseconds() {
			if p := s.people[channelID][u]; p != nil {
				p.excused, p.readyAt = true, 0
			}
		} else {
			waiting = append(waiting, u)
		}
	}
	if len(waiting) == len(st.Waiting) {
		s.scheduleLocked(channelID, b, now) // fired early: arm again
		s.mu.Unlock()
		return
	}
	s.setWaitingLocked(st, b, waiting, now)
	u := s.updateLocked(channelID)
	s.mu.Unlock()
	s.publish(u)
}

// Start puts a link on for the channel, replacing what was on.
func (s *Service) Start(userID, channelID id.ID, raw string) (WatchUpdate, error) {
	viewers := s.viewers(channelID)
	if !slices.Contains(viewers, userID) {
		return WatchUpdate{}, ErrNotInVoice
	}
	link, err := ParseLink(raw)
	if err != nil {
		return WatchUpdate{}, err
	}
	st := &WatchState{
		ChannelID: channelID, URL: link.URL, Kind: link.Kind, VideoID: link.VideoID, Position: link.Start,
		StartedBy: userID, LastActor: userID, LastAction: "start", Waiting: []id.ID{},
	}
	s.pub.Lock()
	defer s.pub.Unlock()
	s.mu.Lock()
	now := s.now().UnixMilli()
	st.UpdatedAt, st.Seq = now, now // server time: a restarted watch never reuses a seq
	if old := s.states[channelID]; old != nil {
		st.Seq = max(now, old.Seq+1)
	}
	s.endLocked(channelID)
	s.pruneLocked(channelID, viewers)
	b := newBarrier()
	s.states[channelID], s.bars[channelID] = st, b
	s.holdLocked(st, b, viewers, now)
	u := s.updateLocked(channelID)
	titles := s.titles
	s.mu.Unlock()
	s.publish(u)
	if titles != nil {
		s.fillTitle(titles, st)
	}
	return u, nil
}

// fillTitle looks the title up in the background and announces it, unless the watch was replaced or stopped meanwhile.
func (s *Service) fillTitle(titles Titles, st *WatchState) {
	channelID, link := st.ChannelID, st.URL // never change after Start
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.wg.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.wg.Done()
		ctx, cancel := context.WithTimeout(s.ctx, titleTimeout)
		defer cancel()
		p, err := titles.Get(ctx, link)
		if err != nil || p == nil || p.Title == "" {
			return
		}
		s.pub.Lock()
		defer s.pub.Unlock()
		s.mu.Lock()
		if s.states[channelID] != st {
			s.mu.Unlock()
			return
		}
		st.Title = p.Title
		u := s.updateLocked(channelID)
		s.mu.Unlock()
		s.publish(u)
	}()
}

// change brings the position up to now, applies fn, starts a new wait and announces the result.
func (s *Service) change(userID, channelID id.ID, action string, fn func(st *WatchState) error) (WatchUpdate, error) {
	viewers := s.viewers(channelID)
	if !slices.Contains(viewers, userID) {
		return WatchUpdate{}, ErrNotInVoice
	}
	s.pub.Lock()
	defer s.pub.Unlock()
	s.mu.Lock()
	st := s.states[channelID]
	if st == nil {
		s.mu.Unlock()
		return WatchUpdate{}, ErrNothingPlaying
	}
	now := s.now().UnixMilli()
	st.Position, st.UpdatedAt = st.at(now), now
	if err := fn(st); err != nil {
		s.mu.Unlock()
		return WatchUpdate{}, err
	}
	st.LastActor, st.LastAction = userID, action
	st.Seq++
	s.holdLocked(st, s.bars[channelID], viewers, now)
	u := s.updateLocked(channelID)
	s.mu.Unlock()
	s.publish(u)
	return u, nil
}

func (s *Service) Play(userID, channelID id.ID) (WatchUpdate, error) {
	return s.change(userID, channelID, "play", func(st *WatchState) error { st.Paused = false; return nil })
}

func (s *Service) Pause(userID, channelID id.ID) (WatchUpdate, error) {
	return s.change(userID, channelID, "pause", func(st *WatchState) error { st.Paused = true; return nil })
}

func (s *Service) Seek(userID, channelID id.ID, position float64) (WatchUpdate, error) {
	return s.change(userID, channelID, "seek", func(st *WatchState) error {
		if st.Kind == KindTwitchLive {
			return ErrNotSeekable
		}
		st.Position = max(0, position)
		return nil
	})
}

// Report is a viewer saying whether their player is loading, answering the watch's seq.
// A report for another seq, for a live stream, or one that changes nothing does nothing.
func (s *Service) Report(userID, channelID id.ID, seq int64, buffering bool) error {
	if !s.inChannel(userID, channelID) {
		return ErrNotInVoice
	}
	s.pub.Lock()
	defer s.pub.Unlock()
	s.mu.Lock()
	st, b := s.states[channelID], s.bars[channelID]
	if st == nil {
		s.mu.Unlock()
		return ErrNothingPlaying
	}
	p := s.personLocked(channelID, userID) // any report says they have a player open
	if st.Seq != seq || st.Kind == KindTwitchLive {
		s.mu.Unlock()
		return nil
	}
	now := s.now().UnixMilli()
	waiting := st.Waiting
	if buffering {
		switch {
		case st.Paused || slices.Contains(waiting, userID):
		case !s.countsLocked(channelID, userID, now):
			p.readyAt = 0 // not loaded steadily yet
		default:
			waiting = append(slices.Clone(waiting), userID)
		}
	} else {
		if p.readyAt == 0 {
			p.readyAt = now
		}
		waiting = slices.DeleteFunc(slices.Clone(waiting), func(u id.ID) bool { return u == userID })
	}
	if len(waiting) == len(st.Waiting) {
		s.mu.Unlock()
		return nil
	}
	s.setWaitingLocked(st, b, waiting, now)
	u := s.updateLocked(channelID)
	s.mu.Unlock()
	s.publish(u)
	return nil
}

// Stop ends the channel's watch.
func (s *Service) Stop(userID, channelID id.ID) error {
	if !s.inChannel(userID, channelID) {
		return ErrNotInVoice
	}
	s.pub.Lock()
	defer s.pub.Unlock()
	s.mu.Lock()
	if s.states[channelID] == nil {
		s.mu.Unlock()
		return ErrNothingPlaying
	}
	s.endLocked(channelID)
	u := s.updateLocked(channelID)
	s.mu.Unlock()
	s.publish(u)
	return nil
}

// onEvent notices people joining or leaving a channel that watches something. Voice publishes
// while holding its own lock, so asking it who is left happens on another goroutine.
func (s *Service) onEvent(e events.Event) {
	if e.Type != "VOICE_STATE_UPDATE" || e.Scope.ChannelID == 0 {
		return
	}
	channelID := e.Scope.ChannelID
	s.mu.Lock()
	st := s.states[channelID]
	if st == nil || s.closed {
		s.mu.Unlock()
		return
	}
	s.wg.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.wg.Done()
		s.syncViewers(channelID, st)
	}()
}

// syncViewers ends the watch st if nobody is left, and stops waiting for anyone who left; a newer watch is left alone.
func (s *Service) syncViewers(channelID id.ID, st *WatchState) {
	s.pub.Lock()
	defer s.pub.Unlock()
	viewers := s.viewers(channelID)
	s.mu.Lock()
	if s.states[channelID] != st {
		s.mu.Unlock()
		return
	}
	s.pruneLocked(channelID, viewers)
	if len(viewers) == 0 {
		s.endLocked(channelID)
	} else {
		waiting := slices.DeleteFunc(slices.Clone(st.Waiting), func(u id.ID) bool { return !slices.Contains(viewers, u) })
		if len(waiting) == len(st.Waiting) {
			s.mu.Unlock()
			return
		}
		s.setWaitingLocked(st, s.bars[channelID], waiting, s.now().UnixMilli())
	}
	u := s.updateLocked(channelID)
	s.mu.Unlock()
	s.publish(u)
}
