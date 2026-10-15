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
	s.afterFunc = func(time.Duration, func()) func() { return func() {} } // tests call expire themselves
	t.Cleanup(s.Close)
	return s, v, clock, bus, rec
}

func TestStartPauseSeekPlay(t *testing.T) {
	s, _, clock, _, rec := setup(t)
	watching(s, lounge, alice)

	u, err := s.Start(alice, lounge, video+"?t=30")
	require.NoError(t, err)
	require.Equal(t, int64(1_000_000), u.ServerNow)
	seq := u.State.Seq
	require.Equal(t, WatchState{
		ChannelID: lounge, URL: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", Kind: KindYouTube, VideoID: "dQw4w9WgXcQ",
		Position: 30, UpdatedAt: 1_000_000, StartedBy: alice, LastActor: alice, LastAction: "start",
		Seq: seq, Waiting: []id.ID{alice},
	}, *u.State)
	require.Equal(t, u, rec.last())
	require.NoError(t, s.Report(alice, lounge, seq, false)) // loaded: the clock runs
	require.Empty(t, rec.last().State.Waiting)

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
	require.Empty(t, u.State.Waiting) // paused: nothing waits
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
	require.Equal(t, []id.ID{alice}, u.State.Waiting) // play waits again
	require.NoError(t, s.Report(alice, lounge, u.State.Seq, false))
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

// watching marks users as having a player for ch, as a report from each would.
func watching(s *Service, ch id.ID, users ...id.ID) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, u := range users {
		s.personLocked(ch, u)
	}
}

func TestBarrierHoldsTheClockUntilEveryoneLoaded(t *testing.T) {
	s, v, clock, _, rec := setup(t)
	v.set(lounge, alice, bob)
	watching(s, lounge, alice, bob)
	u, err := s.Start(alice, lounge, video)
	require.NoError(t, err)
	seq := u.State.Seq
	require.Equal(t, []id.ID{alice, bob}, u.State.Waiting)

	clock.Add(3 * time.Second)
	require.Zero(t, s.Get(lounge).State.at(clock.Now().UnixMilli())) // frozen while waiting

	require.NoError(t, s.Report(alice, lounge, seq, false))
	require.Equal(t, []id.ID{bob}, rec.last().State.Waiting)
	clock.Add(time.Second)
	require.NoError(t, s.Report(bob, lounge, seq, false))
	st := rec.last().State
	require.Empty(t, st.Waiting)
	require.Zero(t, st.Position) // resumes where it froze, no jump
	require.Equal(t, int64(1_004_000), st.UpdatedAt)

	clock.Add(2 * time.Second)
	require.InDelta(t, 2, s.Get(lounge).State.at(clock.Now().UnixMilli()), 0.001)
}

func TestStallMidPlayFreezesForEveryone(t *testing.T) {
	s, v, clock, _, rec := setup(t)
	v.set(lounge, alice, bob)
	watching(s, lounge, alice, bob)
	u, _ := s.Start(alice, lounge, video)
	seq := u.State.Seq
	require.NoError(t, s.Report(alice, lounge, seq, false))
	require.NoError(t, s.Report(bob, lounge, seq, false))

	clock.Add(5 * time.Second)
	require.NoError(t, s.Report(bob, lounge, seq, true))
	st := rec.last().State
	require.Equal(t, []id.ID{bob}, st.Waiting)
	require.InDelta(t, 5, st.Position, 0.001)
	require.Equal(t, seq, st.Seq) // a stall is not a user action

	clock.Add(2 * time.Second)
	require.InDelta(t, 5, s.Get(lounge).State.at(clock.Now().UnixMilli()), 0.001)
	require.NoError(t, s.Report(bob, lounge, seq, false))
	clock.Add(time.Second)
	require.InDelta(t, 6, s.Get(lounge).State.at(clock.Now().UnixMilli()), 0.001)
}

func TestPauseClearsTheWaitAndSeqGuardsReports(t *testing.T) {
	s, v, _, _, rec := setup(t)
	v.set(lounge, alice, bob)
	watching(s, lounge, alice, bob)
	u, _ := s.Start(alice, lounge, video)
	first := u.State.Seq

	u, err := s.Pause(alice, lounge)
	require.NoError(t, err)
	require.Empty(t, u.State.Waiting)
	require.Equal(t, first+1, u.State.Seq)

	n := len(rec.got)
	require.NoError(t, s.Report(bob, lounge, first, true))       // stale seq
	require.NoError(t, s.Report(bob, lounge, u.State.Seq, true)) // paused: nothing waits
	require.Len(t, rec.got, n)

	u, _ = s.Seek(alice, lounge, 50)
	require.Empty(t, u.State.Waiting) // still paused
	u, _ = s.Play(alice, lounge)
	require.Equal(t, []id.ID{alice, bob}, u.State.Waiting)
	require.NoError(t, s.Report(alice, lounge, u.State.Seq-1, false)) // stale: ignored
	require.Equal(t, []id.ID{alice, bob}, s.Get(lounge).State.Waiting)
}

func TestNoOpReportsDoNotPublish(t *testing.T) {
	s, v, _, _, rec := setup(t)
	v.set(lounge, alice, bob)
	watching(s, lounge, alice, bob)
	u, _ := s.Start(alice, lounge, video)
	seq := u.State.Seq
	n := len(rec.got)
	require.NoError(t, s.Report(bob, lounge, seq, true)) // already waited for
	require.Len(t, rec.got, n)
	require.NoError(t, s.Report(alice, lounge, seq, false))
	require.NoError(t, s.Report(alice, lounge, seq, false)) // already ready
	require.Len(t, rec.got, n+1)
}

func TestLiveNeverWaits(t *testing.T) {
	s, v, _, _, rec := setup(t)
	v.set(lounge, alice, bob)
	watching(s, lounge, alice, bob)
	u, err := s.Start(alice, lounge, "https://www.twitch.tv/xqc")
	require.NoError(t, err)
	require.Empty(t, u.State.Waiting)
	n := len(rec.got)
	require.NoError(t, s.Report(bob, lounge, u.State.Seq, true))
	require.Len(t, rec.got, n)
}

func TestReportErrors(t *testing.T) {
	s, _, _, _, _ := setup(t)
	require.ErrorIs(t, s.Report(alice, lounge, 1, true), ErrNothingPlaying)
	_, _ = s.Start(alice, lounge, video)
	require.ErrorIs(t, s.Report(bob, lounge, 1, true), ErrNotInVoice)
}

func TestSeqNeverRepeats(t *testing.T) {
	s, _, clock, _, _ := setup(t)
	watching(s, lounge, alice)
	u, _ := s.Start(alice, lounge, video)
	first := u.State.Seq
	u, _ = s.Start(alice, lounge, video) // same millisecond: still a new seq
	require.Greater(t, u.State.Seq, first)
	require.NoError(t, s.Stop(alice, lounge))
	clock.Add(time.Second)
	u, _ = s.Start(alice, lounge, video) // after a stop: server time, not reset to a small number
	require.Greater(t, u.State.Seq, first)
	require.NoError(t, s.Report(alice, lounge, first, false))
	require.Equal(t, []id.ID{alice}, s.Get(lounge).State.Waiting) // the old watch's report did nothing
}

func TestJoinerNotInBarrierUntilStall(t *testing.T) {
	s, v, _, _, _ := setup(t)
	watching(s, lounge, alice)
	u, _ := s.Start(alice, lounge, video)
	seq := u.State.Seq
	v.set(lounge, alice, bob) // bob joins during the wait
	require.Equal(t, []id.ID{alice}, s.Get(lounge).State.Waiting)
	require.NoError(t, s.Report(alice, lounge, seq, false))
	require.NoError(t, s.Report(bob, lounge, seq, true)) // bob's player is loading
	require.Equal(t, []id.ID{bob}, s.Get(lounge).State.Waiting)
}

type fakeTimers struct {
	mu     sync.Mutex
	delays []time.Duration
}

func (f *fakeTimers) after(d time.Duration, _ func()) func() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.delays = append(f.delays, d)
	return func() {}
}

func (f *fakeTimers) last() time.Duration {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.delays[len(f.delays)-1]
}

func TestExpiryPlaysOnWithoutTheSlowest(t *testing.T) {
	s, v, clock, _, rec := setup(t)
	ft := &fakeTimers{}
	s.afterFunc = ft.after
	v.set(lounge, alice, bob)
	watching(s, lounge, alice, bob)
	u, _ := s.Start(alice, lounge, video)
	seq := u.State.Seq
	require.Equal(t, MaxWait, ft.last())

	require.NoError(t, s.Report(alice, lounge, seq, false))
	clock.Add(5 * time.Second)
	require.NoError(t, s.Report(alice, lounge, seq, true)) // alice stalls 5 s in
	require.Equal(t, []id.ID{bob, alice}, rec.last().State.Waiting)

	clock.Add(4 * time.Second)
	s.expire(lounge) // early: nobody is overdue
	require.Equal(t, []id.ID{bob, alice}, s.Get(lounge).State.Waiting)

	clock.Add(time.Second)
	s.expire(lounge) // bob has waited 10 s, alice 5 s
	require.Equal(t, []id.ID{alice}, rec.last().State.Waiting)
	require.Equal(t, 5*time.Second, ft.last()) // re-armed for alice
	clock.Add(5 * time.Second)
	s.expire(lounge)
	require.Empty(t, rec.last().State.Waiting)
}

func TestExcusedViewerCountsAgainAfterLoadedExcuseFor(t *testing.T) {
	s, v, clock, _, _ := setup(t)
	v.set(lounge, alice, bob)
	watching(s, lounge, alice, bob)
	u, _ := s.Start(alice, lounge, video)
	require.NoError(t, s.Report(alice, lounge, u.State.Seq, false))
	clock.Add(MaxWait)
	s.expire(lounge) // bob is excused
	require.Empty(t, s.Get(lounge).State.Waiting)

	seq := s.Get(lounge).State.Seq
	require.NoError(t, s.Report(bob, lounge, seq, true)) // excused: does not hold the room
	require.Empty(t, s.Get(lounge).State.Waiting)

	require.NoError(t, s.Report(bob, lounge, seq, false)) // ready at T
	clock.Add(20 * time.Second)
	require.NoError(t, s.Report(bob, lounge, seq, true))  // stalls again: not steady yet
	require.NoError(t, s.Report(bob, lounge, seq, false)) // ready at T+20
	clock.Add(25 * time.Second)
	u, _ = s.Seek(alice, lounge, 0)
	require.Equal(t, []id.ID{alice}, u.State.Waiting) // 25 s steady: still excused
	clock.Add(5 * time.Second)
	u, _ = s.Seek(alice, lounge, 0)
	require.Equal(t, []id.ID{alice, bob}, u.State.Waiting) // 30 s steady: counts again
}

func TestExcuseOutlivesStartUntilReady(t *testing.T) {
	s, v, clock, _, _ := setup(t)
	v.set(lounge, alice, bob)
	watching(s, lounge, alice, bob)
	u, _ := s.Start(alice, lounge, video)
	require.NoError(t, s.Report(alice, lounge, u.State.Seq, false))
	clock.Add(MaxWait)
	s.expire(lounge) // bob is excused
	u, _ = s.Start(alice, lounge, video)
	require.Equal(t, []id.ID{alice}, u.State.Waiting) // a new video does not forgive a bad connection
	require.NoError(t, s.Report(bob, lounge, u.State.Seq, false))
	clock.Add(ExcuseFor)
	u, _ = s.Seek(alice, lounge, 0)
	require.Equal(t, []id.ID{alice, bob}, u.State.Waiting)
}

func TestOnlyViewersWithAPlayerAreWaitedFor(t *testing.T) {
	s, v, _, _, _ := setup(t)
	carol := id.ID(12)
	v.set(lounge, alice, bob, carol)
	watching(s, lounge, alice, bob) // carol is in the call but has no player open
	u, err := s.Start(alice, lounge, video)
	require.NoError(t, err)
	require.Equal(t, []id.ID{alice, bob}, u.State.Waiting)

	// Nobody in a fresh call has a player yet: the first start does not wait, and any report says "I have one".
	s2, v2, _, _, _ := setup(t)
	v2.set(lounge, alice, bob)
	u, _ = s2.Start(alice, lounge, video)
	require.Empty(t, u.State.Waiting)
	require.NoError(t, s2.Report(bob, lounge, u.State.Seq, false))
	u, _ = s2.Seek(alice, lounge, 0)
	require.Equal(t, []id.ID{bob}, u.State.Waiting)
}

func TestLeavingForgetsThePlayer(t *testing.T) {
	s, v, _, bus, _ := setup(t)
	v.set(lounge, alice, bob)
	watching(s, lounge, alice, bob)
	_, _ = s.Start(alice, lounge, video)
	v.set(lounge, alice)
	bus.Publish(events.Event{Type: "VOICE_STATE_UPDATE", Data: voice.VoiceState{UserID: bob}, Scope: events.Scope{ChannelID: lounge}})
	s.wg.Wait()
	v.set(lounge, alice, bob) // back, but with no player open yet
	u, _ := s.Seek(alice, lounge, 0)
	require.Equal(t, []id.ID{alice}, u.State.Waiting)
}

func TestMaxWaitAddsUpAcrossStalls(t *testing.T) {
	s, v, clock, _, _ := setup(t)
	ft := &fakeTimers{}
	s.afterFunc = ft.after
	v.set(lounge, alice, bob)
	watching(s, lounge, alice, bob)
	u, _ := s.Start(alice, lounge, video)
	seq := u.State.Seq
	require.NoError(t, s.Report(alice, lounge, seq, false))
	require.NoError(t, s.Report(bob, lounge, seq, false))
	for range 2 { // bob plays a little, stalls 4 s, again and again
		clock.Add(time.Second)
		require.NoError(t, s.Report(bob, lounge, seq, true))
		clock.Add(4 * time.Second)
		require.NoError(t, s.Report(bob, lounge, seq, false))
	}
	clock.Add(time.Second)
	require.NoError(t, s.Report(bob, lounge, seq, true))
	require.Equal(t, 2*time.Second, ft.last()) // 8 s of his 10 are spent
	clock.Add(2 * time.Second)
	s.expire(lounge)
	require.Empty(t, s.Get(lounge).State.Waiting)
	require.NoError(t, s.Report(bob, lounge, seq, true)) // excused: no longer holds the room
	require.Empty(t, s.Get(lounge).State.Waiting)
}

func TestExpireAfterStopIsHarmless(t *testing.T) {
	s, v, clock, _, rec := setup(t)
	v.set(lounge, alice, bob)
	watching(s, lounge, alice, bob)
	_, _ = s.Start(alice, lounge, video)
	require.NoError(t, s.Stop(alice, lounge))
	n := len(rec.got)
	clock.Add(MaxWait)
	s.expire(lounge)
	require.Len(t, rec.got, n)
	require.Nil(t, s.Get(lounge).State)
}

func TestLeavingStopsTheWait(t *testing.T) {
	s, v, _, bus, rec := setup(t)
	v.set(lounge, alice, bob)
	watching(s, lounge, alice, bob)
	_, _ = s.Start(alice, lounge, video)
	v.set(lounge, alice) // bob left mid-wait
	bus.Publish(events.Event{Type: "VOICE_STATE_UPDATE", Data: voice.VoiceState{UserID: bob}, Scope: events.Scope{ChannelID: lounge}})
	s.wg.Wait()
	require.Equal(t, []id.ID{alice}, rec.last().State.Waiting)
}
