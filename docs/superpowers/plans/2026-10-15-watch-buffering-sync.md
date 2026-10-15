# Watch Together: Wait for the Slowest Viewer, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When any viewer is loading, everyone else in the watch pauses at the same moment. Once the slowest has loaded, all play together. The room waits at most 10 s for one viewer.

**Architecture:** The server holds a per-channel barrier. `WatchState.waiting` lists who the room waits for. The shared clock freezes while that list isn't empty. `seq` identifies the user action a buffering report answers. Clients report buffering and readiness over a new REST endpoint. Pure client logic in `sync.ts` decides when to report and treats "held" like paused.

**Tech Stack:** Go 1.25 + huma/v2 (server, testify); React 18 + TypeScript, vitest (web client); openapi-typescript codegen (`clients/core`).

**Spec:** `docs/superpowers/specs/2026-10-14-watch-buffering-sync-design.md`

## Global Constraints

- Max wait per viewer: **10 s** (`MaxWait`). An excused viewer counts again after staying loaded **30 s** (`ExcuseFor`).
- Client: a stall is reported after **750 ms** (`STALL_MS`). A viewer is ready with **3 s** loaded ahead (`READY_AHEAD_S`). Samples run every **500 ms**. An unanswered report is resent every **2 s**.
- Twitch live never waits. YouTube live streams (server kind `youtube`) report ready at once and never report buffering.
- New endpoint: `POST /api/channels/{channelID}/watch/buffering`, body `{seq, buffering}`, returns 204. Errors: 403 `NOT_IN_VOICE`, 400 `NOTHING_PLAYING`. A stale `seq` returns 204 and has no effect.
- `WatchState.waiting` is never null in JSON.
- **Never commit** (AGENTS.md: the user makes all commits). Every "Checkpoint" step means: run the checks, then leave the work uncommitted.
- The web UI is dark-only and uses token classes only (AGENTS.md §6). Accessible names stay unchanged.
- `WatchTile.tsx` and `players/twitch.ts` are also edited by the Twitch mature-gate session, so touch only the lines named here.

## Review Focus

1. A watch stopped and restarted (or replaced) must not accept a stale report from the old one. Pinned by `TestSeqNeverRepeats` (Task 1).
2. Someone who joins voice during a wait isn't added to it, but their own stall is. Pinned by `TestJoinerNotInBarrierUntilStall` (Task 1).
3. An expiry timer that fires after the watch was stopped or replaced must neither publish nor panic. Pinned by `TestExpireAfterStopIsHarmless` (Task 2).
4. A lost "buffering" or "ready" request must not leave the room stuck. The client resends every 2 s. Pinned by the `nextReport` resend test (Task 4).
5. A YouTube live stream must not freeze the room. `loadedAhead()` returns `undefined` for live, so `isReady` is true, and the hook never reports buffering for live. Pinned by the `isReady` undefined case (Task 4) and the hook code in Task 6.

## File map

| file | change |
|---|---|
| `server/internal/watch/watch.go` | `Seq`/`Waiting` fields, `barrier`, hold/report/expire/prune logic |
| `server/internal/watch/watch_test.go` | barrier state-machine tests; existing tests adjusted for the wait |
| `server/internal/watch/handlers.go` | `BufferingRequest` + `report-watch-buffering` operation |
| `server/internal/watch/handlers_test.go` | 403 case for the new endpoint |
| `clients/core/openapi.json`, `clients/core/src/schema.d.ts` | regenerated |
| `clients/core/src/client.ts` | `watchBuffering()` |
| `clients/core/src/store.test.ts` | fixtures gain `seq`, `waiting` |
| `clients/web/src/app/watch/sync.ts` | `held`, `isReady`, `nextReport`, `stallDetector`, `describeWaiting` |
| `clients/web/src/app/watch/sync.test.ts` | tests for the above |
| `clients/web/src/app/watch/players/types.ts`, `youtube.ts`, `twitch.ts` | `buffering()`, `loadedAhead()` |
| `clients/web/src/app/watch/use-watch-sync.ts` | held-aware reconcile + report loop |
| `clients/web/src/app/watch/WatchTile.tsx` | wait line, toolbar visible while waiting, toast keyed on `seq` |

---

### Task 1: Server barrier (seq, waiting, hold, report)

**Files:**
- Modify: `server/internal/watch/watch.go`
- Test: `server/internal/watch/watch_test.go`

**Interfaces:**
- Produces:
  - `WatchState.Seq int64` (`json:"seq"`) and `WatchState.Waiting []id.ID` (`json:"waiting" nullable:"false"`)
  - `func (s *Service) Report(userID, channelID id.ID, seq int64, buffering bool) error`
  - `MaxWait`, `ExcuseFor`
  - `s.afterFunc func(time.Duration, func()) (stop func())` and `s.expire(channelID id.ID)`; Task 2 adds the expiry behaviour

- [ ] **Step 1: Write the failing tests**

In `watch_test.go`, make `setup` disable real timers by adding after `s.now = clock.Now`:

```go
	s.afterFunc = func(time.Duration, func()) func() { return func() {} } // tests call expire themselves
```

Update `TestStartPauseSeekPlay` for the wait. Replace its body up to the first `clock.Add` with:

```go
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
```

Then, just before its final `clock.Add(2 * time.Second)`, add:

```go
	require.Equal(t, []id.ID{alice}, u.State.Waiting) // play waits again
	require.NoError(t, s.Report(alice, lounge, u.State.Seq, false))
```

Also in that test, after `u, err = s.Seek(alice, lounge, 100)` and its `require.NoError`, add `require.Empty(t, u.State.Waiting) // paused: nothing waits`.

Append the new tests:

```go
func TestBarrierHoldsTheClockUntilEveryoneLoaded(t *testing.T) {
	s, v, clock, _, rec := setup(t)
	v.set(lounge, alice, bob)
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
	u, _ := s.Start(alice, lounge, video)
	first := u.State.Seq

	u, err := s.Pause(alice, lounge)
	require.NoError(t, err)
	require.Empty(t, u.State.Waiting)
	require.Equal(t, first+1, u.State.Seq)

	n := len(rec.got)
	require.NoError(t, s.Report(bob, lounge, first, true))        // stale seq
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
	u, _ := s.Start(alice, lounge, video)
	seq := u.State.Seq
	v.set(lounge, alice, bob) // bob joins during the wait
	require.Equal(t, []id.ID{alice}, s.Get(lounge).State.Waiting)
	require.NoError(t, s.Report(alice, lounge, seq, false))
	require.NoError(t, s.Report(bob, lounge, seq, true)) // bob's player is loading
	require.Equal(t, []id.ID{bob}, s.Get(lounge).State.Waiting)
}
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `rtk go -C server test ./internal/watch/`
Expected: compile errors: `s.afterFunc undefined`, `Seq`/`Waiting` unknown fields, `s.Report undefined`.

- [ ] **Step 3: Implement in `watch.go`**

Add `"math"` and `"slices"` to the imports.

Add the fields to `WatchState`, after `LastAction`:

```go
	Seq        int64   `json:"seq" doc:"Changes with every start, play, pause and seek; buffering reports name the seq they answer"`
	Waiting    []id.ID `json:"waiting" nullable:"false" doc:"Viewers the room waits for while their players load; the position holds while any are listed"`
```

Below the `titleTimeout` const, add:

```go
const (
	// MaxWait is how long the room waits for one viewer before playing on without them.
	MaxWait = 10 * time.Second
	// ExcuseFor is how long a viewer the room gave up on must stay loaded before it waits for them again.
	ExcuseFor = 30 * time.Second
)

// barrier is what a channel's watch keeps about slow viewers, beside its WatchState.
type barrier struct {
	since   map[id.ID]int64 // when each viewer in Waiting entered it (ms)
	excused map[id.ID]bool  // the room gave up on them; not waited for until loaded ExcuseFor
	readyAt map[id.ID]int64 // when each viewer became ready; absent since a stall or being excused
	stop    func()          // cancels the pending expiry; nil when none
}

func newBarrier() *barrier {
	return &barrier{since: map[id.ID]int64{}, excused: map[id.ID]bool{}, readyAt: map[id.ID]int64{}}
}

func (b *barrier) cancel() {
	if b.stop != nil {
		b.stop()
		b.stop = nil
	}
}

// counts says whether the room waits for u; an excused viewer counts again once loaded ExcuseFor.
func (b *barrier) counts(u id.ID, now int64) bool {
	if !b.excused[u] {
		return true
	}
	if r := b.readyAt[u]; r > 0 && now-r >= ExcuseFor.Milliseconds() {
		delete(b.excused, u)
		return true
	}
	return false
}
```

In `Service`, add after `now func() time.Time`:

```go
	afterFunc func(d time.Duration, f func()) (stop func()) // time.AfterFunc; tests replace it
```

and after `states map[id.ID]*WatchState`:

```go
	bars   map[id.ID]*barrier // beside states, same keys
```

In `NewService`, initialise both:

```go
	s := &Service{bus: bus, channels: ch, voice: v, now: time.Now, states: map[id.ID]*WatchState{}, bars: map[id.ID]*barrier{}, ctx: ctx, cancel: cancel,
		afterFunc: func(d time.Duration, f func()) func() { t := time.AfterFunc(d, f); return func() { t.Stop() } }}
```

`Close` cancels pending expiries:

```go
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
```

`at` freezes while anyone is waited for:

```go
// at is where playback is at server time now (ms).
func (st *WatchState) at(now int64) float64 {
	if st.Paused || st.Kind == KindTwitchLive || len(st.Waiting) > 0 {
		return st.Position
	}
	return st.Position + float64(now-st.UpdatedAt)/1000
}
```

`updateLocked` must not share the `Waiting` backing array with what it publishes:

```go
	if st := s.states[channelID]; st != nil {
		c := *st
		c.Waiting = slices.Clone(st.Waiting)
		u.State = &c
	}
```

Replace `inChannel` with `viewers` plus `inChannel` built on it:

```go
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
```

Add the barrier helpers (all called with `mu` held):

```go
// setWaitingLocked replaces who the room waits for, folding the position first so the clock stops or restarts at now.
func (s *Service) setWaitingLocked(st *WatchState, b *barrier, waiting []id.ID, now int64) {
	st.Position, st.UpdatedAt = st.at(now), now
	st.Waiting = waiting
	for u := range b.since {
		if !slices.Contains(waiting, u) {
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
			if b.counts(u, now) {
				waiting = append(waiting, u)
			}
		}
	}
	clear(b.since) // everyone's MaxWait starts over
	s.setWaitingLocked(st, b, waiting, now)
}

// scheduleLocked arms the expiry for the earliest viewer's MaxWait.
func (s *Service) scheduleLocked(channelID id.ID, b *barrier, now int64) {
	b.cancel()
	if len(b.since) == 0 || s.closed {
		return
	}
	first := int64(math.MaxInt64)
	for _, t := range b.since {
		first = min(first, t)
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
```

Task 2 adds the real `expire`. For now add a stub so the code compiles:

```go
// expire plays on without the viewers the room has waited MaxWait for.
func (s *Service) expire(channelID id.ID) {}
```

Rewrite `Start`:

```go
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
```

Rewrite `change`:

```go
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
```

In `Stop`, replace `delete(s.states, channelID)` with `s.endLocked(channelID)`. In `clearIfEmpty`, make the same replacement (Task 3 rewrites that function anyway).

Add `Report`:

```go
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
	if st.Seq != seq || st.Kind == KindTwitchLive {
		s.mu.Unlock()
		return nil
	}
	now := s.now().UnixMilli()
	waiting := st.Waiting
	if buffering {
		switch {
		case st.Paused || slices.Contains(waiting, userID):
		case !b.counts(userID, now):
			delete(b.readyAt, userID) // not loaded steadily yet
		default:
			waiting = append(slices.Clone(waiting), userID)
		}
	} else {
		if b.readyAt[userID] == 0 {
			b.readyAt[userID] = now
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
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `rtk go -C server test -race ./internal/watch/`
Expected: PASS, all tests including the existing ones.

- [ ] **Step 5: Checkpoint**

Run: `rtk go -C server vet ./internal/watch/`. Leave the work uncommitted (the user commits).

---

### Task 2: Expiry and excuse

**Files:**
- Modify: `server/internal/watch/watch.go` (replace the `expire` stub)
- Test: `server/internal/watch/watch_test.go`

**Interfaces:**
- Consumes: `barrier`, `setWaitingLocked`, `scheduleLocked`, `s.afterFunc`, `MaxWait`, `ExcuseFor` (Task 1)
- Produces: `func (s *Service) expire(channelID id.ID)`

- [ ] **Step 1: Write the failing tests**

```go
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
	require.NoError(t, s.Report(bob, lounge, seq, true)) // stalls again: not steady yet
	require.NoError(t, s.Report(bob, lounge, seq, false)) // ready at T+20
	clock.Add(25 * time.Second)
	u, _ = s.Seek(alice, lounge, 0)
	require.Equal(t, []id.ID{alice}, u.State.Waiting) // 25 s steady: still excused
	clock.Add(5 * time.Second)
	u, _ = s.Seek(alice, lounge, 0)
	require.Equal(t, []id.ID{alice, bob}, u.State.Waiting) // 30 s steady: counts again
}

func TestStartForgetsExcuses(t *testing.T) {
	s, v, clock, _, _ := setup(t)
	v.set(lounge, alice, bob)
	u, _ := s.Start(alice, lounge, video)
	require.NoError(t, s.Report(alice, lounge, u.State.Seq, false))
	clock.Add(MaxWait)
	s.expire(lounge)
	u, _ = s.Start(alice, lounge, video)
	require.Equal(t, []id.ID{alice, bob}, u.State.Waiting)
}

func TestExpireAfterStopIsHarmless(t *testing.T) {
	s, v, clock, _, rec := setup(t)
	v.set(lounge, alice, bob)
	_, _ = s.Start(alice, lounge, video)
	require.NoError(t, s.Stop(alice, lounge))
	n := len(rec.got)
	clock.Add(MaxWait)
	s.expire(lounge)
	require.Len(t, rec.got, n)
	require.Nil(t, s.Get(lounge).State)
}
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `rtk go -C server test ./internal/watch/ -run 'Expir|Excuse|Forgets'`
Expected: FAIL. With the stub, `Waiting` never shrinks.

- [ ] **Step 3: Implement `expire`**

Replace the stub:

```go
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
		if now-b.since[u] >= MaxWait.Milliseconds() {
			b.excused[u] = true
			delete(b.readyAt, u)
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
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `rtk go -C server test -race ./internal/watch/`
Expected: PASS.

- [ ] **Step 5: Checkpoint.** Leave it uncommitted.

---

### Task 3: Voice-leave pruning, the HTTP endpoint and codegen

**Files:**
- Modify: `server/internal/watch/watch.go` (`onEvent`, `clearIfEmpty` → `syncViewers`)
- Modify: `server/internal/watch/handlers.go`
- Test: `server/internal/watch/watch_test.go`, `server/internal/watch/handlers_test.go`
- Regenerate: `clients/core/openapi.json`, `clients/core/src/schema.d.ts`
- Modify: `clients/core/src/client.ts`, `clients/core/src/store.test.ts`

**Interfaces:**
- Consumes: `Report`, `setWaitingLocked`, `endLocked`, `viewers` (Task 1)
- Produces:
  - `POST /api/channels/{channelID}/watch/buffering` (operation `report-watch-buffering`, 204)
  - `client.watchBuffering(channelId: string, seq: number, buffering: boolean): Promise<void>`
  - TS `WatchState` gains `seq: number; waiting: string[]`

- [ ] **Step 1: Write the failing tests**

`watch_test.go`:

```go
func TestLeavingStopsTheWait(t *testing.T) {
	s, v, _, bus, rec := setup(t)
	v.set(lounge, alice, bob)
	_, _ = s.Start(alice, lounge, video)
	v.set(lounge, alice) // bob left mid-wait
	bus.Publish(events.Event{Type: "VOICE_STATE_UPDATE", Data: voice.VoiceState{UserID: bob}, Scope: events.Scope{ChannelID: lounge}})
	s.wg.Wait()
	require.Equal(t, []id.ID{alice}, rec.last().State.Waiting)
}
```

`handlers_test.go`, after the existing seek `Fail` line:

```go
	alice.Fail(http.MethodPost, base+"/buffering", map[string]any{"seq": 1, "buffering": true}, http.StatusForbidden, "NOT_IN_VOICE")
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `rtk go -C server test ./internal/watch/`
Expected: `TestLeavingStopsTheWait` fails (Waiting still `[alice bob]`). `TestWatchHTTP` fails with 404/405 instead of 403.

- [ ] **Step 3: Implement**

In `watch.go`, `onEvent`'s goroutine calls `s.syncViewers(channelID, st)`. Replace `clearIfEmpty` with:

```go
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
```

In `handlers.go`, add after `SeekRequest`:

```go
type BufferingRequest struct {
	Seq       int64 `json:"seq" doc:"The watch's seq this answers"`
	Buffering bool  `json:"buffering" doc:"True while my player loads, false once it can play"`
}
```

and register it after `seek-watch`:

```go
	huma.Register(api, op("report-watch-buffering", http.MethodPost, "/api/channels/{channelID}/watch/buffering", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			ChannelID string `path:"channelID"`
			Body      BufferingRequest
		}) (*struct{}, error) {
			ch, err := voiceChannel(ctx, in.ChannelID)
			if err != nil {
				return nil, err
			}
			if err := s.Report(me(ctx), ch, in.Body.Seq, in.Body.Buffering); err != nil {
				return nil, apiError(err)
			}
			return nil, nil
		})
```

Regenerate types:

Run: `pnpm -C clients/core gen`
Then check: `grep -n "waiting\|seq:" clients/core/src/schema.d.ts`. Expected: `waiting: string[];` with **no** `| null`, and `seq: number;`. If huma ignores `nullable:"false"` and emits `string[] | null`, the field already never marshals null (`Waiting` is always a non-nil slice). In that case `held()` in Task 4 uses `(st.waiting?.length ?? 0) > 0`; note this in the task report.

In `clients/core/src/client.ts`, add after `watchSeek`:

```ts
  /** Tells the server whether my player is loading, answering the watch's seq: the room waits for loading viewers. */
  async watchBuffering(channelId: string, seq: number, buffering: boolean) {
    await unwrap(this.api.POST("/api/channels/{channelID}/watch/buffering", { params: { path: { channelID: channelId } }, body: { seq, buffering } }));
  }
```

In `clients/core/src/store.test.ts`, add `seq: 1, waiting: [],` to each of the three `WatchState` fixtures, after `last_action: "start",`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `rtk go -C server test -race ./internal/watch/ && pnpm -C clients/core test && pnpm -C clients/core typecheck`
Expected: PASS. (`clients/web` typecheck fails until Task 4 adds `waiting` to its fixtures, which is expected.)

- [ ] **Step 5: Checkpoint.** Leave it uncommitted.

---

### Task 4: Client sync logic (pure, `sync.ts`)

**Files:**
- Modify: `clients/web/src/app/watch/sync.ts`
- Test: `clients/web/src/app/watch/sync.test.ts`

**Interfaces:**
- Consumes: TS `WatchState.waiting`, `WatchState.seq` (Task 3)
- Produces:
  - `held(st: Pick<WatchState, "paused" | "waiting">): boolean`
  - `READY_AHEAD_S = 3`, `STALL_MS = 750`, `RESEND_MS = 2000`
  - `type Load = { time: number; duration: number; buffering: boolean; loadedAhead: number | undefined }`, `isReady(l: Load): boolean`
  - `type Tracker = { seq: number; stallSince?: number; sent?: boolean; sentAt?: number }`
  - `type ReportInput = { seq: number; now: number; buffering: boolean; ready: boolean; waitingOnMe: boolean; held: boolean }`
  - `nextReport(t: Tracker, i: ReportInput): { tracker: Tracker; send?: boolean }`
  - `stallDetector(): (paused: boolean, time: number, now: number) => boolean`
  - `describeWaiting(waiting: readonly string[], meId: string | undefined, name: (id: string) => string): string`
  - `expectedPosition` now takes `Clocked` including `waiting`

- [ ] **Step 1: Write the failing tests**

In `sync.test.ts`, change the import to:

```ts
import { DRIFT_S, describeAction, describeWaiting, expectedPosition, formatTime, held, isReady, nextReport, reconcile, stallDetector } from "./sync";
```

Add `waiting: []` to the `yt` fixture:

```ts
const yt = { kind: "youtube", paused: false, position: 10, updated_at: 1_000_000, last_action: "play", waiting: [] as string[] } as const;
```

Append:

```ts
describe("held", () => {
  it("is paused, or waiting for anyone", () => {
    expect(held(yt)).toBe(false);
    expect(held({ ...yt, paused: true })).toBe(true);
    expect(held({ ...yt, waiting: ["11"] })).toBe(true);
  });
  it("freezes the expected position while waiting", () => {
    expect(expectedPosition({ ...yt, waiting: ["11"] }, 1_009_000, 0)).toBe(10);
  });
});

describe("isReady", () => {
  const l = { time: 10, duration: 600, buffering: false, loadedAhead: 3 };
  it("needs READY_AHEAD_S loaded and no buffering", () => {
    expect(isReady(l)).toBe(true);
    expect(isReady({ ...l, loadedAhead: 2.9 })).toBe(false);
    expect(isReady({ ...l, buffering: true })).toBe(false);
  });
  it("is ready near the end, and when the player cannot tell (Twitch, live)", () => {
    expect(isReady({ ...l, time: 599.2, loadedAhead: 0.8 })).toBe(true);
    expect(isReady({ ...l, loadedAhead: undefined })).toBe(true);
    expect(isReady({ ...l, loadedAhead: undefined, buffering: true })).toBe(false);
  });
});

describe("nextReport", () => {
  const base = { seq: 5, now: 0, buffering: false, ready: false, waitingOnMe: false, held: false };
  it("reports a stall only after STALL_MS, once", () => {
    let r = nextReport({ seq: 5 }, { ...base, buffering: true });
    expect(r.send).toBeUndefined();
    r = nextReport(r.tracker, { ...base, buffering: true, now: 500 });
    expect(r.send).toBeUndefined();
    r = nextReport(r.tracker, { ...base, buffering: true, now: 750 });
    expect(r.send).toBe(true);
    r = nextReport(r.tracker, { ...base, buffering: true, now: 1250 });
    expect(r.send).toBeUndefined();
  });
  it("forgets a short blip", () => {
    let r = nextReport({ seq: 5 }, { ...base, buffering: true });
    r = nextReport(r.tracker, { ...base, now: 500 });
    r = nextReport(r.tracker, { ...base, buffering: true, now: 1000 });
    expect(r.send).toBeUndefined();
  });
  it("does not report stalls while the room is held", () => {
    let r = nextReport({ seq: 5 }, { ...base, buffering: true, held: true });
    r = nextReport(r.tracker, { ...base, buffering: true, held: true, now: 2000 });
    expect(r.send).toBeUndefined();
  });
  it("reports ready when the room waits for me", () => {
    let r = nextReport({ seq: 5 }, { ...base, waitingOnMe: true, held: true });
    expect(r.send).toBeUndefined();
    r = nextReport(r.tracker, { ...base, waitingOnMe: true, held: true, ready: true, now: 500 });
    expect(r.send).toBe(false);
    r = nextReport(r.tracker, { ...base, waitingOnMe: true, held: true, ready: true, now: 1000 });
    expect(r.send).toBeUndefined();
  });
  it("resends after RESEND_MS when the server has not caught up", () => {
    let r = nextReport({ seq: 5 }, { ...base, waitingOnMe: true, ready: true });
    expect(r.send).toBe(false);
    r = nextReport(r.tracker, { ...base, waitingOnMe: true, ready: true, now: 2000 });
    expect(r.send).toBe(false);
    let s = nextReport({ seq: 5 }, { ...base, buffering: true });
    s = nextReport(s.tracker, { ...base, buffering: true, now: 750 });
    expect(s.send).toBe(true);
    s = nextReport(s.tracker, { ...base, buffering: true, now: 2750 });
    expect(s.send).toBe(true);
  });
  it("starts over on a new seq", () => {
    let r = nextReport({ seq: 5 }, { ...base, waitingOnMe: true, ready: true });
    expect(r.send).toBe(false);
    r = nextReport(r.tracker, { ...base, seq: 6, waitingOnMe: true, ready: true, now: 100 });
    expect(r.send).toBe(false);
    expect(r.tracker.seq).toBe(6);
  });
});

describe("stallDetector", () => {
  it("is stalled when time moves under 0.25 s across a second of playing", () => {
    const d = stallDetector();
    expect(d(false, 10, 0)).toBe(false);
    expect(d(false, 10.1, 500)).toBe(false); // under a second: keep the last answer
    expect(d(false, 10.1, 1000)).toBe(true);
    expect(d(false, 11.1, 2000)).toBe(false);
  });
  it("is never stalled while paused, and starts over after", () => {
    const d = stallDetector();
    d(false, 10, 0);
    expect(d(true, 10, 1000)).toBe(false);
    expect(d(false, 10, 1500)).toBe(false);
  });
});

describe("describeWaiting", () => {
  const names: Record<string, string> = { "10": "Anna", "11": "Bo" };
  const name = (id: string) => names[id] ?? id;
  it("names others, says Loading when only me, empty when nobody", () => {
    expect(describeWaiting([], "10", name)).toBe("");
    expect(describeWaiting(["10"], "10", name)).toBe("Loading…");
    expect(describeWaiting(["10", "11"], "10", name)).toBe("Waiting for Bo…");
    expect(describeWaiting(["10", "11"], "12", name)).toBe("Waiting for Anna, Bo…");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm -C clients/web exec vitest run src/app/watch/sync.test.ts`
Expected: FAIL. `held`, `isReady`, `nextReport`, `stallDetector` and `describeWaiting` are not exported.

- [ ] **Step 3: Implement in `sync.ts`**

Replace the `Clocked` type and `expectedPosition`:

```ts
type Clocked = Pick<WatchState, "kind" | "paused" | "position" | "updated_at" | "waiting">;

/** Paused, or waiting for someone's player to load: either way the shared position holds. */
export function held(st: Pick<WatchState, "paused" | "waiting">): boolean {
  return st.paused || st.waiting.length > 0;
}

/** Where playback should be now (seconds): the server's position, plus the time since on the server's clock while it runs. */
export function expectedPosition(st: Clocked, nowMs: number, offsetMs: number): number {
  if (held(st) || st.kind === "twitch_live") return st.position;
  return st.position + Math.max(0, nowMs + offsetMs - st.updated_at) / 1000;
}
```

Append after `reconcile`:

```ts
/** Seconds loaded ahead before a waited-for player counts as ready. */
export const READY_AHEAD_S = 3;
/** How long a player must stall before the room waits for it (ms). */
export const STALL_MS = 750;
/** How long before an unanswered report is sent again (ms). */
export const RESEND_MS = 2000;

/** What a player says about loading. `loadedAhead` is undefined when the player cannot tell. */
export type Load = { time: number; duration: number; buffering: boolean; loadedAhead: number | undefined };

export function isReady(l: Load): boolean {
  if (l.buffering) return false;
  if (l.loadedAhead === undefined) return true;
  if (l.duration > 0 && l.time >= l.duration - 1) return true;
  return l.loadedAhead >= READY_AHEAD_S;
}

/** What has been reported for a seq: `sent` is the last value sent. */
export type Tracker = { seq: number; stallSince?: number; sent?: boolean; sentAt?: number };
export type ReportInput = { seq: number; now: number; buffering: boolean; ready: boolean; waitingOnMe: boolean; held: boolean };

/** Whether to tell the server I am loading (true) or ready (false): a stall once it lasts STALL_MS, ready when the room waits for me; resent every RESEND_MS until the server catches up. */
export function nextReport(t: Tracker, i: ReportInput): { tracker: Tracker; send?: boolean } {
  const tr: Tracker = t.seq === i.seq ? t : { seq: i.seq };
  const due = (v: boolean) => tr.sent !== v || i.now - (tr.sentAt ?? 0) >= RESEND_MS;
  if (i.waitingOnMe) {
    if (i.ready && due(false)) return { tracker: { seq: i.seq, sent: false, sentAt: i.now }, send: false };
    return { tracker: { ...tr, stallSince: undefined } };
  }
  if (i.held || !i.buffering) return { tracker: { ...tr, stallSince: undefined } };
  const since = tr.stallSince ?? i.now;
  if (i.now - since >= STALL_MS && due(true)) return { tracker: { seq: i.seq, stallSince: since, sent: true, sentAt: i.now }, send: true };
  return { tracker: { ...tr, stallSince: since } };
}

/** For players without a buffering event: stalled when the time moved under 0.25 s across a second of meant-to-be playing. */
export function stallDetector() {
  let last: { time: number; at: number } | undefined;
  let stalled = false;
  return (paused: boolean, time: number, now: number): boolean => {
    if (paused) {
      last = undefined;
      stalled = false;
      return false;
    }
    if (!last) {
      last = { time, at: now };
      return false;
    }
    if (now - last.at < 1000) return stalled;
    stalled = time - last.time < 0.25;
    last = { time, at: now };
    return stalled;
  };
}

/** The wait line: "Waiting for Anna, Bo…", or "Loading…" when the room waits only for me; "" when it waits for nobody. */
export function describeWaiting(waiting: readonly string[], meId: string | undefined, name: (id: string) => string): string {
  if (!waiting.length) return "";
  const others = waiting.filter((u) => u !== meId);
  return others.length ? `Waiting for ${others.map(name).join(", ")}…` : "Loading…";
}
```

Check `"resends after RESEND_MS"`. On the second ready call, at `now: 2000`, `sentAt` is 0, so `due(false)` is true and it resends. In `"reports ready when the room waits for me"`, the call at `now: 1000` has `sentAt: 500` → 500 ms < 2000, so it doesn't resend. Both tests pass.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm -C clients/web exec vitest run src/app/watch/sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint.** Leave it uncommitted.

---

### Task 5: Players report buffering and loaded-ahead

**Files:**
- Modify: `clients/web/src/app/watch/players/types.ts`, `players/youtube.ts`, `players/twitch.ts`

**Interfaces:**
- Consumes: `stallDetector` (Task 4)
- Produces: `WatchPlayer.buffering(): boolean`, `WatchPlayer.loadedAhead(): number | undefined`

These are thin adapters over the embed APIs; they're covered by typecheck plus the pure tests in Task 4.

- [ ] **Step 1: Extend the interface** (`types.ts`, after `playing()`):

```ts
  buffering(): boolean; // meant to be playing but stalled
  loadedAhead(): number | undefined; // seconds loaded past currentTime; undefined when the player cannot tell
```

- [ ] **Step 2: Run typecheck and confirm it fails**

Run: `pnpm -C clients/web typecheck`
Expected: errors in `youtube.ts` and `twitch.ts`, because the returned object is missing `buffering` and `loadedAhead`.

- [ ] **Step 3: YouTube.** In `YTPlayer`, add `getVideoLoadedFraction?(): number;` after `getPlayerState?(): number;`. In the returned object, after `playing`, add:

```ts
    buffering: () => p.getPlayerState?.() === BUFFERING,
    loadedAhead: () => {
      if (p.getVideoData?.().isLive) return undefined;
      const d = p.getDuration?.() ?? 0;
      return d ? Math.max(0, (p.getVideoLoadedFraction?.() ?? 0) * d - (p.getCurrentTime?.() ?? 0)) : 0;
    },
```

- [ ] **Step 4: Twitch.** This is a minimal edit, because the mature-gate session also edits this file. Add `import { stallDetector } from "../sync";` after the `types` import. Inside `createTwitch`, before `return {`, add `const stall = stallDetector();`. In the returned object, after `playing`, add:

```ts
    buffering: () => stall(p.isPaused(), p.getCurrentTime(), performance.now()), // the embed has no buffering event
    loadedAhead: () => undefined,
```

- [ ] **Step 5: Run typecheck and confirm it passes**

Run: `pnpm -C clients/web typecheck`
Expected: PASS for the players. `use-watch-sync.ts` may still pass, since it doesn't call the new methods yet.

- [ ] **Step 6: Checkpoint.** Leave it uncommitted.

---

### Task 6: Hook and tile wiring

**Files:**
- Modify: `clients/web/src/app/watch/use-watch-sync.ts`, `clients/web/src/app/watch/WatchTile.tsx`

**Interfaces:**
- Consumes: `held`, `isReady`, `nextReport`, `Tracker`, `describeWaiting` (Task 4); `player.buffering()`, `player.loadedAhead()` (Task 5); `client.watchBuffering` (Task 3)

- [ ] **Step 1: Hook.** In `use-watch-sync.ts`:

Change the imports:

```ts
import { client, useApp } from "../../session";
import { expectedPosition, held, isReady, nextReport, reconcile, type Tracker } from "./sync";
```

Add `const SAMPLE_MS = 500;` under `AUTOPLAY_GRACE_MS`.

Add the current user id next to the other refs:

```ts
  const meId = useApp((s) => s.me?.id);
  const meRef = useRef(meId);
  meRef.current = meId;
```

In the reconcile tick, make three changes:
- Pass `paused: held(cur)` instead of `paused: cur.paused` in the `reconcile` call.
- In the autoplay timer, change `!stRef.current.paused` to `!held(stRef.current)`.
- In `unblock`, change `if (!stRef.current?.paused) player?.play();` to `if (stRef.current && !held(stRef.current)) player?.play();`.

Add the report loop after the reconcile effect:

```ts
  // Tell the server when my player stalls, and when it has loaded while the room waits for me.
  useEffect(() => {
    if (!player) return;
    let tracker: Tracker = { seq: -1 };
    const sample = () => {
      const cur = stRef.current;
      if (!cur || cur.kind === "twitch_live") return;
      const live = player.live(); // a YouTube live stream: nothing to wait for
      const buffering = !live && player.buffering();
      const ready = live || isReady({ time: player.currentTime(), duration: player.duration(), buffering, loadedAhead: player.loadedAhead() });
      const me = meRef.current;
      const r = nextReport(tracker, { seq: cur.seq, now: Date.now(), buffering, ready, waitingOnMe: !!me && cur.waiting.includes(me), held: held(cur) });
      tracker = r.tracker;
      if (r.send !== undefined) client.watchBuffering(channelId, cur.seq, r.send).catch(() => {}); // resent on a later sample
    };
    const interval = window.setInterval(sample, SAMPLE_MS);
    return () => window.clearInterval(interval);
  }, [player, channelId]);
```

- [ ] **Step 2: Tile.** In `WatchTile.tsx`, make only these edits:

Import `describeWaiting` alongside the other `./sync` imports:

```ts
import { describeAction, describeWaiting, expectedPosition, formatTime } from "./sync";
```

After the `actor` selector, add:

```ts
  const waitLine = useApp((s) => (st ? describeWaiting(st.waiting, s.me?.id, (u) => userName(s, u)) : ""));
```

Change `const stamp = st?.updated_at;` to:

```ts
  const stamp = st?.seq; // a wait starting or ending moves updated_at; only user actions change seq
```

Change the comment above it to match: "A late title or a wait does not change seq, so it does not re-toast."

In the toolbar's opacity class, change `st.paused ? "opacity-100"` to `st.paused || waitLine ? "opacity-100"`.

Replace the "Paused by" line:

```tsx
            {waitLine
              ? <span className="truncate text-xs text-muted-foreground">{waitLine}</span>
              : st.paused && st.last_action === "pause" && <span className="truncate text-xs text-muted-foreground">Paused by {actor}</span>}
```

- [ ] **Step 3: Run the full client checks**

Run: `pnpm typecheck && pnpm -C clients/web test && pnpm -C clients/core test && pnpm lint`
Expected: PASS (no new lint errors; `react-hooks/exhaustive-deps` is satisfied because refs are read inside effects).

- [ ] **Step 4: Run the full server checks**

Run: `rtk go -C server test -race ./... && rtk go -C server vet ./...`
Expected: PASS.

- [ ] **Step 5: Manual smoke test (two browsers)**

Run the dev server per `.claude/launch.json` (or README), log in as two users in one voice channel, start a YouTube video, then:
1. Throttle one browser to "Slow 3G" in DevTools and seek. The other browser pauses and shows "Waiting for {name}…". Both resume together.
2. Keep that browser throttled hard. After about 10 s the other plays on; the slow one catches up by seeking and doesn't freeze the room again until it has stayed loaded for 30 s.
3. Twitch live: no waiting line, ever.

- [ ] **Step 6: Checkpoint.** Leave everything uncommitted. Tell the user the work is ready to commit, and mention that `WatchTile.tsx` and `players/twitch.ts` were also edited by the Twitch mature-gate session.
