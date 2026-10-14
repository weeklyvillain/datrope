package watch

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/linkpreview"
	"github.com/datrope/datrope/server/internal/voice"
)

const (
	lounge id.ID = 300
	alice  id.ID = 10
	bob    id.ID = 11
	video        = "https://youtu.be/dQw4w9WgXcQ"
)

type fakeVoice struct {
	mu sync.Mutex
	in map[id.ID][]id.ID
}

func (f *fakeVoice) States(chs []id.ID) []voice.VoiceState {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []voice.VoiceState
	for _, ch := range chs {
		for _, u := range f.in[ch] {
			c := ch
			out = append(out, voice.VoiceState{UserID: u, ChannelID: &c})
		}
	}
	return out
}

func (f *fakeVoice) set(ch id.ID, users ...id.ID) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.in[ch] = users
}

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// fakeTitles answers after `wait` is closed (nil: at once).
type fakeTitles struct {
	title string
	wait  chan struct{}
}

func (f fakeTitles) Get(ctx context.Context, _ string) (*linkpreview.Preview, error) {
	if f.wait != nil {
		select {
		case <-f.wait:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return &linkpreview.Preview{Title: f.title}, nil
}

type recorder struct {
	mu  sync.Mutex
	got []WatchUpdate
}

func (r *recorder) last() WatchUpdate {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.got[len(r.got)-1]
}

func setup(t *testing.T) (*Service, *fakeVoice, *fakeClock, *events.Bus, *recorder) {
	t.Helper()
	bus := &events.Bus{}
	rec := &recorder{}
	bus.Subscribe(func(e events.Event) {
		if e.Type == "WATCH_UPDATE" {
			rec.mu.Lock()
			rec.got = append(rec.got, e.Data.(WatchUpdate))
			rec.mu.Unlock()
		}
	})
	v := &fakeVoice{in: map[id.ID][]id.ID{lounge: {alice}}}
	clock := &fakeClock{t: time.UnixMilli(1_000_000)}
	s := NewService(bus, nil, v)
	s.now = clock.Now
	t.Cleanup(s.Close)
	return s, v, clock, bus, rec
}

func TestStartPauseSeekPlay(t *testing.T) {
	s, _, clock, _, rec := setup(t)

	u, err := s.Start(alice, lounge, video+"?t=30")
	require.NoError(t, err)
	require.Equal(t, int64(1_000_000), u.ServerNow)
	require.Equal(t, WatchState{
		ChannelID: lounge, URL: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", Kind: KindYouTube, VideoID: "dQw4w9WgXcQ",
		Position: 30, UpdatedAt: 1_000_000, StartedBy: alice, LastActor: alice, LastAction: "start",
	}, *u.State)
	require.Equal(t, u, rec.last())

	clock.Add(10 * time.Second)
	u, err = s.Pause(alice, lounge)
	require.NoError(t, err)
	require.True(t, u.State.Paused)
	require.InDelta(t, 40, u.State.Position, 0.001)
	require.Equal(t, "pause", u.State.LastAction)

	clock.Add(5 * time.Second) // paused: the position stays
	require.InDelta(t, 40, s.Get(lounge).State.Position, 0.001)

	u, err = s.Seek(alice, lounge, 100)
	require.NoError(t, err)
	require.True(t, u.State.Paused)
	require.InDelta(t, 100, u.State.Position, 0.001)
	require.Equal(t, "seek", u.State.LastAction)

	u, err = s.Seek(alice, lounge, -5)
	require.NoError(t, err)
	require.Zero(t, u.State.Position)

	u, err = s.Play(alice, lounge)
	require.NoError(t, err)
	require.False(t, u.State.Paused)
	require.Equal(t, int64(1_015_000), u.State.UpdatedAt)
	clock.Add(2 * time.Second)
	require.InDelta(t, 2, s.Get(lounge).State.at(clock.Now().UnixMilli()), 0.001)
}

func TestStartReplaces(t *testing.T) {
	s, _, _, _, _ := setup(t)
	_, err := s.Start(alice, lounge, video)
	require.NoError(t, err)
	u, err := s.Start(alice, lounge, "https://www.twitch.tv/xQc")
	require.NoError(t, err)
	require.Equal(t, KindTwitchLive, u.State.Kind)
	require.Equal(t, "xqc", u.State.VideoID)
}

func TestNotInVoice(t *testing.T) {
	s, _, _, _, _ := setup(t)
	_, err := s.Start(bob, lounge, video)
	require.ErrorIs(t, err, ErrNotInVoice)
	_, err = s.Start(alice, lounge, video)
	require.NoError(t, err)
	_, err = s.Pause(bob, lounge)
	require.ErrorIs(t, err, ErrNotInVoice)
	require.ErrorIs(t, s.Stop(bob, lounge), ErrNotInVoice)
}

func TestNothingPlaying(t *testing.T) {
	s, _, _, _, _ := setup(t)
	require.Nil(t, s.Get(lounge).State)
	_, err := s.Play(alice, lounge)
	require.ErrorIs(t, err, ErrNothingPlaying)
	_, err = s.Seek(alice, lounge, 3)
	require.ErrorIs(t, err, ErrNothingPlaying)
	require.ErrorIs(t, s.Stop(alice, lounge), ErrNothingPlaying)
}

func TestUnsupportedLink(t *testing.T) {
	s, _, _, _, _ := setup(t)
	_, err := s.Start(alice, lounge, "https://example.com/video")
	require.ErrorIs(t, err, ErrUnsupportedLink)
}

func TestLiveNotSeekable(t *testing.T) {
	s, _, clock, _, _ := setup(t)
	_, err := s.Start(alice, lounge, "https://www.twitch.tv/xqc")
	require.NoError(t, err)
	_, err = s.Seek(alice, lounge, 10)
	require.ErrorIs(t, err, ErrNotSeekable)
	clock.Add(time.Minute)
	st := s.Get(lounge).State
	require.Zero(t, st.at(clock.Now().UnixMilli())) // live has no position
}

func TestStopPublishesAbsentState(t *testing.T) {
	s, _, _, _, rec := setup(t)
	_, err := s.Start(alice, lounge, video)
	require.NoError(t, err)
	require.NoError(t, s.Stop(alice, lounge))
	require.Nil(t, rec.last().State)
	require.Equal(t, lounge, rec.last().ChannelID)
	require.Nil(t, s.Get(lounge).State)
}

func TestTitleFilledIn(t *testing.T) {
	s, _, _, _, rec := setup(t)
	s.SetTitles(fakeTitles{title: "Never Gonna Give You Up"})
	_, err := s.Start(alice, lounge, video)
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		st := s.Get(lounge).State
		return st != nil && st.Title == "Never Gonna Give You Up"
	}, time.Second, 10*time.Millisecond)
	require.Eventually(t, func() bool { return rec.last().State.Title == "Never Gonna Give You Up" }, time.Second, 10*time.Millisecond)
}

func TestLateTitleIgnoredAfterReplace(t *testing.T) {
	s, _, _, _, _ := setup(t)
	wait := make(chan struct{})
	s.SetTitles(fakeTitles{title: "Old video", wait: wait})
	_, err := s.Start(alice, lounge, video)
	require.NoError(t, err)
	s.SetTitles(nil) // the second start fetches nothing
	_, err = s.Start(alice, lounge, "https://www.twitch.tv/xqc")
	require.NoError(t, err)
	close(wait)
	s.wg.Wait()
	require.Empty(t, s.Get(lounge).State.Title)

	// Stopped while the lookup runs: it must not come back.
	wait = make(chan struct{})
	s.SetTitles(fakeTitles{title: "Old video", wait: wait})
	_, err = s.Start(alice, lounge, video)
	require.NoError(t, err)
	require.NoError(t, s.Stop(alice, lounge))
	close(wait)
	s.wg.Wait()
	require.Nil(t, s.Get(lounge).State)
}

func TestClearsWhenCallEmpties(t *testing.T) {
	s, v, _, bus, rec := setup(t)
	_, err := s.Start(alice, lounge, video)
	require.NoError(t, err)
	v.set(lounge)
	bus.Publish(events.Event{Type: "VOICE_STATE_UPDATE", Data: voice.VoiceState{UserID: alice}, Scope: events.Scope{ChannelID: lounge}})
	s.wg.Wait()
	require.Nil(t, s.Get(lounge).State)
	require.Nil(t, rec.last().State)
}

func TestKeepsWatchWhileSomeoneStays(t *testing.T) {
	s, v, _, bus, _ := setup(t)
	v.set(lounge, alice, bob)
	_, err := s.Start(alice, lounge, video)
	require.NoError(t, err)
	v.set(lounge, bob) // alice left, bob stays
	bus.Publish(events.Event{Type: "VOICE_STATE_UPDATE", Data: voice.VoiceState{UserID: alice}, Scope: events.Scope{ChannelID: lounge}})
	s.wg.Wait()
	require.NotNil(t, s.Get(lounge).State)
}

func TestPublishesInOrder(t *testing.T) {
	s, _, _, _, rec := setup(t)
	_, err := s.Start(alice, lounge, video)
	require.NoError(t, err)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if i%2 == 0 {
				_, _ = s.Pause(alice, lounge)
			} else {
				_, _ = s.Play(alice, lounge)
			}
		}()
	}
	wg.Wait()
	require.Equal(t, s.Get(lounge).State, rec.last().State)
}
