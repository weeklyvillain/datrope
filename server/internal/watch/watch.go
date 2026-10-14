// Package watch lets the people in a voice channel watch a YouTube video or a
// Twitch stream together: the server keeps what is on and where it is, and
// every client keeps its own player in step.
package watch

import (
	"context"
	"errors"
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

type Service struct {
	bus      *events.Bus
	channels Channels
	voice    Voice
	titles   Titles // nil: no titles
	now      func() time.Time

	// pub serialises a change and its publish, so updates go out in the order they happened.
	// Never taken in onEvent, which runs under voice's lock.
	pub sync.Mutex

	mu     sync.Mutex
	states map[id.ID]*WatchState
	closed bool // guarded by mu; no new background work once set

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func NewService(bus *events.Bus, ch Channels, v Voice) *Service {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Service{bus: bus, channels: ch, voice: v, now: time.Now, states: map[id.ID]*WatchState{}, ctx: ctx, cancel: cancel}
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
	s.mu.Unlock()
	s.cancel()
	s.wg.Wait()
}

// at is where playback is at server time now (ms).
func (st *WatchState) at(now int64) float64 {
	if st.Paused || st.Kind == KindTwitchLive {
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
		u.State = &c
	}
	return u
}

func (s *Service) publish(u WatchUpdate) {
	s.bus.Publish(events.Event{Type: "WATCH_UPDATE", Data: u, Scope: events.Scope{ChannelID: u.ChannelID}})
}

func (s *Service) inChannel(userID, channelID id.ID) bool {
	for _, v := range s.voice.States([]id.ID{channelID}) {
		if v.UserID == userID {
			return true
		}
	}
	return false
}

// Start puts a link on for the channel, replacing what was on.
func (s *Service) Start(userID, channelID id.ID, raw string) (WatchUpdate, error) {
	if !s.inChannel(userID, channelID) {
		return WatchUpdate{}, ErrNotInVoice
	}
	link, err := ParseLink(raw)
	if err != nil {
		return WatchUpdate{}, err
	}
	st := &WatchState{
		ChannelID: channelID, URL: link.URL, Kind: link.Kind, VideoID: link.VideoID, Position: link.Start,
		StartedBy: userID, LastActor: userID, LastAction: "start",
	}
	s.pub.Lock()
	defer s.pub.Unlock()
	s.mu.Lock()
	st.UpdatedAt = s.now().UnixMilli()
	s.states[channelID] = st
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

// change brings the position up to now, applies fn and announces the result.
func (s *Service) change(userID, channelID id.ID, action string, fn func(st *WatchState) error) (WatchUpdate, error) {
	if !s.inChannel(userID, channelID) {
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
	delete(s.states, channelID)
	u := s.updateLocked(channelID)
	s.mu.Unlock()
	s.publish(u)
	return nil
}

// onEvent notices people leaving a channel that watches something. Voice publishes
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
		s.clearIfEmpty(channelID, st)
	}()
}

// clearIfEmpty ends the watch st if nobody is left; a newer watch is left alone.
func (s *Service) clearIfEmpty(channelID id.ID, st *WatchState) {
	s.pub.Lock()
	defer s.pub.Unlock()
	if len(s.voice.States([]id.ID{channelID})) > 0 {
		return
	}
	s.mu.Lock()
	if s.states[channelID] != st {
		s.mu.Unlock()
		return
	}
	delete(s.states, channelID)
	u := s.updateLocked(channelID)
	s.mu.Unlock()
	s.publish(u)
}
