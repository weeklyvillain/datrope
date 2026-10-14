# Watch Together Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People in a voice channel watch a YouTube video, a Twitch VOD or a live Twitch stream in sync, and anyone in the call can play, pause, seek, change or stop it.

**Architecture:**
- **Server:** a new Go package `server/internal/watch` keeps one in-memory `WatchState` per voice channel. REST actions change it and publish `WATCH_UPDATE` (with `server_now`) to everyone who can view the channel. The state is cleared when the call empties.
- **Web client:** the official YouTube IFrame API and Twitch Embed JS sit under our own control bar. Each client works out the expected position from the server's clock and seeks when it drifts more than 1.5s.
- **UI:** the video is a tile in the call that takes the stage (mockup A).

**Tech Stack:** Go 1.25, Huma v2, the in-process event bus, testify. React 18, zustand, shadcn/ui (Dialog, Input, Slider, Badge, Toggle), Tailwind v4, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-watch-together-design.md`. Mockups: `docs/superpowers/mockups/WatchTogether.html`, concept A.

## Global Constraints

- **Never commit** (AGENTS.md §5). Each task ends with a checkpoint where you report the files and a suggested commit message, and the user commits.
- **Voice channels only.** Every watch endpoint returns 400 `NOT_VOICE_CHANNEL` for other channel types.
- **Anyone in the call controls it.** Not being in the call returns 403 `NOT_IN_VOICE`. This reuses music's code and message style; the spec's `NOT_IN_CHANNEL` is renamed to match music.
- **One item at a time, no queue.** Starting a new link replaces the current one.
- **Kinds are exactly `youtube`, `twitch_live` and `twitch_vod`.** Twitch clips are not supported.
- **Drift threshold** `DRIFT_S = 1.5` seconds. The sync tick runs every 2000 ms. The toast shows for 3000 ms. Autoplay counts as blocked if the player isn't playing 1500 ms after `play()`.
- **No DB, no migration, no audit entries.** The state lives in memory only.
- **The event** is named `WATCH_UPDATE` with payload `{channel_id, state?, server_now}`. `state` is absent when nothing is on. The spec's "null" is represented as an absent field, which is the Huma `omitempty` pattern that `MusicState.current` already uses.
- **CSP:** `script-src` adds exactly `https://www.youtube.com https://embed.twitch.tv`.
- **UI rules:**
  - Use shadcn components only, and token colors only (never hardcoded).
  - The app is dark-only, so no `dark:` variants.
  - Import with `cn()` and the `@/` alias.
  - Accessible names are fixed:
    - "Watch together" for the call-control toggle, the dialog title and the tile region
    - "Video link" for the input
    - "Start watching" for the submit button
    - "Watch controls" for the toolbar
    - "Play", "Pause", "Stop" and "Change"
    - "Position", "Video volume", and "Mute video" / "Unmute video"
- **Help text** is exactly: "Paste a YouTube video or a Twitch channel or VOD. Everyone in {channel} watches it in sync, and anyone can pause, seek or change it."
- **Volume** is per person and kept in `localStorage` key `datrope.watchVolume`, never synced.
- **Pin/unpin** uses the voice view's existing "Grid layout" header toggle, which already switches between stage and grid. The tile gets no separate pin button. This is a deliberate simplification of the spec's "pin/unpin toggle".
- **Switching stage and grid remounts the tile**, so the embed reloads and then re-syncs. This is accepted.

## Review Focus

1. **Video has ended while still "playing" on the server.** The expected position keeps growing past the duration. The client must not seek, then restart, then seek again in a loop: once the expected position reaches the duration, reconcile does nothing. This is pinned in Task 5 (`reconcile` with `duration`).
2. **Someone leaves while others stay.** The watch must not be cleared while anyone is left in the call, only when it empties. This is pinned in Task 2 (`TestKeepsWatchWhileSomeoneStays`).
3. **The title arrives after the watch was replaced or stopped.** A slow title lookup must not write onto the new video or bring a stopped one back. This is pinned in Task 2 (`TestLateTitleIgnoredAfterReplace`).
4. **Pasted links with whitespace, `www.`/`m.` hosts, uppercase Twitch logins, trailing slashes, and `?t=1h2m3s` start times.** These must all parse to one canonical form. This is pinned in Task 1's table.
5. **Clock skew between the client and the server.** The expected position must use the server offset, never the raw local clock. This is pinned in Task 5 (`expectedPosition` with a non-zero offset) and Task 4 (the reducer sets `serverOffset`).

---

## File Structure

**Server (new package `server/internal/watch`)**
- `links.go`: `ParseLink`, a pure URL-to-`Link` parser with canonical URLs and start times.
- `links_test.go`: table tests for `ParseLink`.
- `watch.go`: the types (`WatchState`, `WatchUpdate`), `Service` (in-memory state, actions, clock, publishing, title fill, emptying), and the sentinel errors.
- `watch_test.go` (package `watch`): unit tests with a fake voice, clock and titles.
- `handlers.go`: Huma routes and the mapping from errors to HTTP codes.
- `handlers_test.go` (package `watch_test`): HTTP tests through `apptest`.

**Server (modify)**
- `server/internal/app/app.go`: construct, register, `SetTitles` and close the service, and add the `App.Watch` field.
- `server/internal/app/realtime.go`: register `watch.WatchUpdate{}` in `registerEventSchemas`.

**Core (modify):** `clients/core/openapi.json` and `src/schema.d.ts` (regenerated), `src/types.ts`, `src/store.ts`, `src/store.test.ts`, `src/client.ts`.

**Web (new, `clients/web/src/app/watch/`)**
- `sync.ts` and `sync.test.ts`: `expectedPosition`, `reconcile`, `formatTime`, `describeAction`.
- `load-script.ts`: loads a script tag once.
- `volume.ts`: local volume prefs.
- `players/types.ts`: the `WatchPlayer` interface.
- `players/youtube.ts`: the YouTube IFrame API adapter.
- `players/twitch.ts`: the Twitch Embed adapter.
- `players/index.ts`: `createPlayer`, which picks an adapter by kind.
- `use-watch-sync.ts`: mounts the player and runs the sync loop.
- `WatchTile.tsx`: the tile in the call.
- `WatchDialog.tsx`: the start/change dialog.
- `WatchControl.tsx`: the call-control toggle.

**Web (modify)**
- `clients/web/src/app/voice/StageView.tsx`, `GridView.tsx`, `VoiceStage.tsx`
- `clients/web/src/app/voice/CallControls.tsx`
- `clients/web/src/app/voice/VoiceMembers.tsx`
- `clients/web/e2e/chat.spec.ts`

**Deploy (modify):** `deploy/Caddyfile`.

---

### Task 1: Link parser

**Files:**
- Create: `server/internal/watch/links.go`
- Test: `server/internal/watch/links_test.go`

**Interfaces:**
- Produces:
  - `type Link struct { Kind, VideoID, URL string; Start float64 }`
  - `func ParseLink(raw string) (Link, error)`
  - `var ErrUnsupportedLink error`
  - the constants `KindYouTube = "youtube"`, `KindTwitchLive = "twitch_live"`, `KindTwitchVOD = "twitch_vod"`

- [ ] **Step 1: Write the failing test**

```go
package watch

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseLink(t *testing.T) {
	yt := func(start float64) Link {
		return Link{Kind: KindYouTube, VideoID: "dQw4w9WgXcQ", URL: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", Start: start}
	}
	ok := []struct {
		in   string
		want Link
	}{
		{"https://www.youtube.com/watch?v=dQw4w9WgXcQ", yt(0)},
		{"  https://youtube.com/watch?v=dQw4w9WgXcQ&t=90  ", yt(90)},
		{"https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s", yt(90)},
		{"https://music.youtube.com/watch?v=dQw4w9WgXcQ", yt(0)},
		{"https://youtu.be/dQw4w9WgXcQ?t=1h2m3s", yt(3723)},
		{"https://youtu.be/dQw4w9WgXcQ/", yt(0)},
		{"https://www.youtube.com/shorts/dQw4w9WgXcQ", yt(0)},
		{"https://www.youtube.com/live/dQw4w9WgXcQ?start=12", yt(12)},
		{"https://www.youtube.com/embed/dQw4w9WgXcQ", yt(0)},
		{"http://www.youtube.com/watch?v=dQw4w9WgXcQ", yt(0)},
		{"https://www.twitch.tv/xQc", Link{Kind: KindTwitchLive, VideoID: "xqc", URL: "https://www.twitch.tv/xqc"}},
		{"https://m.twitch.tv/xqc/", Link{Kind: KindTwitchLive, VideoID: "xqc", URL: "https://www.twitch.tv/xqc"}},
		{"https://twitch.tv/videos/2281904417", Link{Kind: KindTwitchVOD, VideoID: "2281904417", URL: "https://www.twitch.tv/videos/2281904417"}},
		{"https://www.twitch.tv/videos/2281904417?t=1h2m3s", Link{Kind: KindTwitchVOD, VideoID: "2281904417", URL: "https://www.twitch.tv/videos/2281904417", Start: 3723}},
	}
	for _, c := range ok {
		got, err := ParseLink(c.in)
		require.NoError(t, err, c.in)
		require.Equal(t, c.want, got, c.in)
	}
	bad := []string{
		"", "not a url", "ftp://youtube.com/watch?v=dQw4w9WgXcQ", "https://example.com/watch?v=dQw4w9WgXcQ",
		"https://www.youtube.com/watch?v=short", "https://www.youtube.com/playlist?list=PL123",
		"https://www.twitch.tv/directory", "https://www.twitch.tv/videos", "https://www.twitch.tv/xqc/clip/Funny-abc",
		"https://clips.twitch.tv/Funny-abc", "https://www.twitch.tv/ab",
	}
	for _, in := range bad {
		_, err := ParseLink(in)
		require.ErrorIs(t, err, ErrUnsupportedLink, in)
	}
}
```

- [ ] **Step 2: Run the test to check it fails**

Run: `go -C server test ./internal/watch/ -run TestParseLink`
Expected: FAIL. It won't compile, with "undefined: Link" and "undefined: ParseLink".

- [ ] **Step 3: Write the implementation**

```go
package watch

import (
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// The kinds of thing a channel can watch.
const (
	KindYouTube    = "youtube"
	KindTwitchLive = "twitch_live"
	KindTwitchVOD  = "twitch_vod"
)

// ErrUnsupportedLink: not a YouTube video, Twitch channel or Twitch VOD.
var ErrUnsupportedLink = errors.New("watch: unsupported link")

var (
	ytID       = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
	twitchName = regexp.MustCompile(`^[A-Za-z0-9_]{3,25}$`)
	digits     = regexp.MustCompile(`^\d+$`)
	hms        = regexp.MustCompile(`^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$`)
)

// Twitch paths that look like a channel name but are not one (the same list as clients/web/src/lib/players.ts).
var twitchReserved = map[string]bool{
	"directory": true, "videos": true, "settings": true, "subscriptions": true, "inventory": true, "wallet": true,
	"downloads": true, "jobs": true, "p": true, "search": true, "turbo": true,
}

// Link is a parsed watchable link: what it is, its ID on its site, its canonical URL and where to start.
type Link struct {
	Kind    string
	VideoID string  // YouTube video ID, Twitch login (lower case) or VOD ID
	URL     string  // canonical
	Start   float64 // seconds; always 0 for a live stream
}

// ParseLink recognises YouTube videos and Twitch channels and VODs.
func ParseLink(raw string) (Link, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return Link{}, ErrUnsupportedLink
	}
	host := strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
	parts := strings.FieldsFunc(u.Path, func(r rune) bool { return r == '/' })
	switch host {
	case "youtu.be":
		if len(parts) == 1 {
			return youtube(parts[0], u)
		}
	case "youtube.com", "m.youtube.com", "music.youtube.com":
		if len(parts) == 1 && parts[0] == "watch" {
			return youtube(u.Query().Get("v"), u)
		}
		if len(parts) == 2 && (parts[0] == "shorts" || parts[0] == "live" || parts[0] == "embed") {
			return youtube(parts[1], u)
		}
	case "twitch.tv", "m.twitch.tv":
		if len(parts) == 2 && parts[0] == "videos" && digits.MatchString(parts[1]) {
			return Link{Kind: KindTwitchVOD, VideoID: parts[1], URL: "https://www.twitch.tv/videos/" + parts[1], Start: seconds(u.Query().Get("t"))}, nil
		}
		if len(parts) == 1 && twitchName.MatchString(parts[0]) && !twitchReserved[strings.ToLower(parts[0])] {
			login := strings.ToLower(parts[0])
			return Link{Kind: KindTwitchLive, VideoID: login, URL: "https://www.twitch.tv/" + login}, nil
		}
	}
	return Link{}, ErrUnsupportedLink
}

func youtube(videoID string, u *url.URL) (Link, error) {
	if !ytID.MatchString(videoID) {
		return Link{}, ErrUnsupportedLink
	}
	q := u.Query()
	t := q.Get("t")
	if t == "" {
		t = q.Get("start")
	}
	return Link{Kind: KindYouTube, VideoID: videoID, URL: "https://www.youtube.com/watch?v=" + videoID, Start: seconds(t)}, nil
}

// seconds reads "90", "90s" or "1h2m3s"; anything else is 0.
func seconds(t string) float64 {
	if t == "" {
		return 0
	}
	if digits.MatchString(t) {
		n, _ := strconv.Atoi(t)
		return float64(n)
	}
	m := hms.FindStringSubmatch(t)
	if m == nil {
		return 0
	}
	n := func(s string) float64 {
		v, _ := strconv.Atoi(s)
		return float64(v)
	}
	return n(m[1])*3600 + n(m[2])*60 + n(m[3])
}
```

- [ ] **Step 4: Run the test to check it passes**

Run: `go -C server test ./internal/watch/ -run TestParseLink`
Expected: PASS.

- [ ] **Step 5: Checkpoint (do not commit)**

Report the files and the suggested message `feat(watch): parse YouTube and Twitch links`.

---

### Task 2: Watch service (state, actions, publishing, title, emptying)

**Files:**
- Create: `server/internal/watch/watch.go`
- Test: `server/internal/watch/watch_test.go` (package `watch`, internal)

**Interfaces:**
- Consumes from Task 1:
  - `ParseLink`, `Link`, `ErrUnsupportedLink`
  - `KindTwitchLive`
- Produces:
  - Types:
    - `type WatchState struct` (JSON fields as in the code below)
    - `type WatchUpdate struct { ChannelID id.ID; State *WatchState; ServerNow int64 }`
  - Interfaces: `Channels`, `Voice`, `Titles`
  - Constructor: `func NewService(bus *events.Bus, ch Channels, v Voice) *Service`
  - Methods on `*Service`:
    - `SetTitles(Titles)`
    - `Close()`
    - `Get(channelID id.ID) WatchUpdate`
    - `Start(userID, channelID id.ID, raw string) (WatchUpdate, error)`
    - `Play(userID, channelID id.ID) (WatchUpdate, error)`
    - `Pause(userID, channelID id.ID) (WatchUpdate, error)`
    - `Seek(userID, channelID id.ID, position float64) (WatchUpdate, error)`
    - `Stop(userID, channelID id.ID) error`
  - Errors: `ErrNotInVoice`, `ErrNothingPlaying`, `ErrNotSeekable`
  - Event type string: `"WATCH_UPDATE"`

- [ ] **Step 1: Write the failing tests**

```go
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
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `go -C server test ./internal/watch/ -run 'Test(Start|Not|Nothing|Unsupported|Live|Stop|Title|Late|Clears|Keeps)'`
Expected: FAIL. They won't compile, with "undefined: NewService".

- [ ] **Step 3: Write the implementation**

```go
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

	mu     sync.Mutex
	states map[id.ID]*WatchState

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
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ctx, cancel := context.WithTimeout(s.ctx, titleTimeout)
		defer cancel()
		p, err := titles.Get(ctx, link)
		if err != nil || p == nil || p.Title == "" {
			return
		}
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
	on := s.states[channelID] != nil
	s.mu.Unlock()
	if !on {
		return
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.clearIfEmpty(channelID)
	}()
}

func (s *Service) clearIfEmpty(channelID id.ID) {
	if len(s.voice.States([]id.ID{channelID})) > 0 {
		return
	}
	s.mu.Lock()
	if s.states[channelID] == nil {
		s.mu.Unlock()
		return
	}
	delete(s.states, channelID)
	u := s.updateLocked(channelID)
	s.mu.Unlock()
	s.publish(u)
}
```

Two notes on this code:
- In `TestLateTitleIgnoredAfterReplace`, `SetTitles(nil)` gives the second `Start` no lookup. That's why `Start` reads `titles` under the lock.
- `max` on floats is the builtin from Go 1.21 and later.

- [ ] **Step 4: Run the package tests with the race detector**

Run: `go -C server test -race ./internal/watch/`
Expected: PASS, with no race reports.

- [ ] **Step 5: Checkpoint (do not commit)**

Suggested message: `feat(watch): in-memory watch state per voice channel`.

---

### Task 3: HTTP routes, app wiring, event schema, OpenAPI

**Files:**
- Create: `server/internal/watch/handlers.go`
- Test: `server/internal/watch/handlers_test.go` (package `watch_test`)
- Modify: `server/internal/app/app.go`. Add the `App.Watch` field near `Music` (around line 48), and wire the service after the music block (around line 210).
- Modify: `server/internal/app/realtime.go:191`. Add `watch.WatchUpdate{}`.
- Regenerate: `clients/core/openapi.json` and `clients/core/src/schema.d.ts`.

**Interfaces:**
- Consumes from Task 2: `Service`, `WatchUpdate`, the errors, and `ErrUnsupportedLink` from Task 1.
- Produces these routes:

| Operation ID | Method and path | Body | Response |
|---|---|---|---|
| `get-watch` | `GET /api/channels/{channelID}/watch` | | 200 `WatchUpdate` |
| `start-watch` | `POST /api/channels/{channelID}/watch` | `{url}` | 200 `WatchUpdate` |
| `play-watch` | `POST /api/channels/{channelID}/watch/play` | | 200 `WatchUpdate` |
| `pause-watch` | `POST /api/channels/{channelID}/watch/pause` | | 200 `WatchUpdate` |
| `seek-watch` | `POST /api/channels/{channelID}/watch/seek` | `{position}` | 200 `WatchUpdate` |
| `stop-watch` | `DELETE /api/channels/{channelID}/watch` | | 204 |

  It also produces the field `app.App.Watch *watch.Service`.

- [ ] **Step 1: Write the failing HTTP test**

```go
package watch_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/watch"
)

func TestWatchHTTP(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	var lounge channels.Channel
	alice.Do(http.MethodPost, "/api/server/channels", map[string]any{"name": "Lounge", "type": "voice"}, http.StatusCreated, &lounge)
	base := "/api/channels/" + lounge.ID.String() + "/watch"

	var u watch.WatchUpdate
	alice.Do(http.MethodGet, base, nil, http.StatusOK, &u)
	require.Equal(t, lounge.ID, u.ChannelID)
	require.Nil(t, u.State)
	require.NotZero(t, u.ServerNow)

	// Controls need the caller in the call; alice only looks at the channel.
	alice.Fail(http.MethodPost, base, map[string]any{"url": "https://youtu.be/dQw4w9WgXcQ"}, http.StatusForbidden, "NOT_IN_VOICE")
	alice.Fail(http.MethodPost, base+"/pause", nil, http.StatusForbidden, "NOT_IN_VOICE")
	alice.Fail(http.MethodPost, base+"/seek", map[string]any{"position": 3}, http.StatusForbidden, "NOT_IN_VOICE")
	alice.Fail(http.MethodDelete, base, nil, http.StatusForbidden, "NOT_IN_VOICE")

	alice.Fail(http.MethodGet, "/api/channels/"+alice.General().String()+"/watch", nil, http.StatusBadRequest, "NOT_VOICE_CHANNEL")
}
```

Being in the call needs LiveKit, which the action paths already cover in Task 2's unit tests through the same `Service` methods.

- [ ] **Step 2: Run it to check it fails**

Run: `go -C server test ./internal/watch/ -run TestWatchHTTP`. It needs Docker for apptest's Postgres, like the other `apptest` tests.
Expected: FAIL. `GET .../watch` returns 404.

- [ ] **Step 3: Write `handlers.go`**

```go
package watch

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type StartRequest struct {
	URL string `json:"url" minLength:"1" maxLength:"500" doc:"A YouTube video, or a Twitch channel or VOD"`
}

type SeekRequest struct {
	Position float64 `json:"position" doc:"Seconds into the video"`
}

type channelPath struct {
	ChannelID string `path:"channelID"`
}

type updateOutput struct {
	Body WatchUpdate
}

// apiError turns the service's errors into HTTP errors.
func apiError(err error) error {
	switch {
	case errors.Is(err, ErrNotInVoice):
		return httpx.E(http.StatusForbidden, "NOT_IN_VOICE", "join the voice channel to control what it watches")
	case errors.Is(err, ErrNothingPlaying):
		return httpx.BadRequest("NOTHING_PLAYING", "nothing is being watched")
	case errors.Is(err, ErrNotSeekable):
		return httpx.BadRequest("NOT_SEEKABLE", "a live stream cannot be seeked")
	case errors.Is(err, ErrUnsupportedLink):
		return httpx.BadRequest("UNSUPPORTED_LINK", "paste a YouTube video, or a Twitch channel or VOD")
	}
	return err
}

func Register(api huma.API, s *Service) {
	tags := []string{"watch"}
	op := func(id, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}
	me := func(ctx context.Context) id.ID { return auth.Current(ctx).User.ID }
	// voiceChannel resolves a voice channel the caller can see.
	voiceChannel := func(ctx context.Context, raw string) (id.ID, error) {
		chID, err := httpx.ParseID(raw, "channel")
		if err != nil {
			return 0, err
		}
		ch, _, err := s.channels.Access(ctx, me(ctx), chID, perms.ViewChannel)
		if err != nil {
			return 0, err
		}
		if ch.Type != channels.TypeVoice {
			return 0, httpx.BadRequest("NOT_VOICE_CHANNEL", "watching together happens in voice channels")
		}
		return ch.ID, nil
	}
	reply := func(u WatchUpdate, err error) (*updateOutput, error) {
		if err != nil {
			return nil, apiError(err)
		}
		return &updateOutput{Body: u}, nil
	}

	huma.Register(api, op("get-watch", http.MethodGet, "/api/channels/{channelID}/watch", 0),
		func(ctx context.Context, in *channelPath) (*updateOutput, error) {
			ch, err := voiceChannel(ctx, in.ChannelID)
			if err != nil {
				return nil, err
			}
			return &updateOutput{Body: s.Get(ch)}, nil
		})

	huma.Register(api, op("start-watch", http.MethodPost, "/api/channels/{channelID}/watch", http.StatusOK),
		func(ctx context.Context, in *struct {
			ChannelID string `path:"channelID"`
			Body      StartRequest
		}) (*updateOutput, error) {
			ch, err := voiceChannel(ctx, in.ChannelID)
			if err != nil {
				return nil, err
			}
			return reply(s.Start(me(ctx), ch, in.Body.URL))
		})

	huma.Register(api, op("play-watch", http.MethodPost, "/api/channels/{channelID}/watch/play", http.StatusOK),
		func(ctx context.Context, in *channelPath) (*updateOutput, error) {
			ch, err := voiceChannel(ctx, in.ChannelID)
			if err != nil {
				return nil, err
			}
			return reply(s.Play(me(ctx), ch))
		})

	huma.Register(api, op("pause-watch", http.MethodPost, "/api/channels/{channelID}/watch/pause", http.StatusOK),
		func(ctx context.Context, in *channelPath) (*updateOutput, error) {
			ch, err := voiceChannel(ctx, in.ChannelID)
			if err != nil {
				return nil, err
			}
			return reply(s.Pause(me(ctx), ch))
		})

	huma.Register(api, op("seek-watch", http.MethodPost, "/api/channels/{channelID}/watch/seek", http.StatusOK),
		func(ctx context.Context, in *struct {
			ChannelID string `path:"channelID"`
			Body      SeekRequest
		}) (*updateOutput, error) {
			ch, err := voiceChannel(ctx, in.ChannelID)
			if err != nil {
				return nil, err
			}
			return reply(s.Seek(me(ctx), ch, in.Body.Position))
		})

	huma.Register(api, op("stop-watch", http.MethodDelete, "/api/channels/{channelID}/watch", http.StatusNoContent),
		func(ctx context.Context, in *channelPath) (*struct{}, error) {
			ch, err := voiceChannel(ctx, in.ChannelID)
			if err != nil {
				return nil, err
			}
			if err := s.Stop(me(ctx), ch); err != nil {
				return nil, apiError(err)
			}
			return nil, nil
		})
}
```

- [ ] **Step 4: Wire it in `app.go`**

Add to the `App` struct, after the `Music` field:

```go
	Watch        *watch.Service   // nil when built without a database
```

Add after the music block, after `a.Music = musicSvc` and its closing `}`:

```go
	watchSvc := watch.NewService(a.Bus, chanSvc, voiceSvc)
	watch.Register(api, watchSvc)
	if pool != nil { // nil only for `datrope openapi`
		watchSvc.SetTitles(linkpreview.New(pool))
		a.closers = append(a.closers, watchSvc.Close)
		a.Watch = watchSvc
	}
```

Add the import `"github.com/datrope/datrope/server/internal/watch"`. `linkpreview` is already imported.

In `realtime.go`, change the line `albums.Album{}, albums.AlbumDeleted{}, albums.ItemsChanged{},` to:

```go
		albums.Album{}, albums.AlbumDeleted{}, albums.ItemsChanged{}, watch.WatchUpdate{},
```

Add the import `"github.com/datrope/datrope/server/internal/watch"`.

- [ ] **Step 5: Run the server tests**

Run: `go -C server test -race ./internal/watch/ ./internal/app/`
Expected: PASS.

Run: `go -C server vet ./...`
Expected: no output.

- [ ] **Step 6: Regenerate the OpenAPI document and the TS schema**

Run: `pnpm --filter @datrope/core gen`

Expected:
- `clients/core/openapi.json` gains the six `watch` operations and the `WatchState` and `WatchUpdate` schemas.
- `clients/core/src/schema.d.ts` gains `components["schemas"]["WatchUpdate"]`.

Check with `grep -n '"WatchUpdate"' clients/core/openapi.json`.

- [ ] **Step 7: Checkpoint (do not commit)**

Suggested message: `feat(watch): REST routes and WATCH_UPDATE event`.

---

### Task 4: Core client and store

**Files:**
- Modify: `clients/core/src/types.ts`. Add the types near `MusicState` (line 77), and add the event at the end of the event map (after `MUSIC_PLAYLIST_DELETE`, around line 126).
- Modify: `clients/core/src/store.ts`. Add the `State` fields (around line 52), `initialState` (around line 74), and the reducer case after `MUSIC_UPDATE` (around line 362).
- Modify: `clients/core/src/client.ts`. Add the methods after `setMusicRepeat` (around line 356).
- Test: `clients/core/src/store.test.ts`.

**Interfaces:**
- Consumes from Task 3: the generated `Schemas["WatchState"]` and `Schemas["WatchUpdate"]`, and the six routes.
- Produces:
  - Types: `WatchState` and `WatchUpdate`
  - Store fields:
    - `State.watch: Record<string, WatchState | null>` (absent means not loaded yet, `null` means nothing is on)
    - `State.serverOffset: number` (ms, server minus local)
  - Client methods:
    - `client.getWatch(channelId): Promise<WatchUpdate>`
    - `client.startWatch(channelId, url): Promise<void>`
    - `client.watchPlay(channelId): Promise<void>`
    - `client.watchPause(channelId): Promise<void>`
    - `client.watchSeek(channelId, position): Promise<void>`
    - `client.stopWatch(channelId): Promise<void>`

- [ ] **Step 1: Write the failing reducer test**

Add `vi` to the vitest import in `store.test.ts` (`import { describe, expect, it, vi } from "vitest";`). Add `WatchState` to the `./types` import. Then add this inside `describe("store", ...)`:

```ts
  it("WATCH_UPDATE sets and clears a channel's watch, and keeps the server clock offset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const st: WatchState = {
        channel_id: "300", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", kind: "youtube", video_id: "dQw4w9WgXcQ",
        paused: false, position: 0, updated_at: 1_000_500, started_by: "20", last_actor: "20", last_action: "start",
      };
      let s = applyEvent(initialState, "WATCH_UPDATE", { channel_id: "300", state: st, server_now: 1_000_500 });
      expect(s.watch["300"]).toEqual(st);
      expect(s.serverOffset).toBe(500);
      s = applyEvent(s, "WATCH_UPDATE", { channel_id: "300", server_now: 999_800 });
      expect(s.watch["300"]).toBeNull();
      expect(s.serverOffset).toBe(-200);
      expect(initialState.watch["300"]).toBeUndefined(); // not loaded
    } finally {
      vi.useRealTimers();
    }
  });
```

- [ ] **Step 2: Run it to check it fails**

Run: `pnpm --filter @datrope/core test -- store`
Expected: FAIL, because `s.watch` is undefined. Or a type error with "WatchState is not exported".

- [ ] **Step 3: Implement**

In `types.ts`, after `export type MusicState = Schemas["MusicState"];`:

```ts
export type WatchState = Schemas["WatchState"];
export type WatchUpdate = Schemas["WatchUpdate"];
```

In the event map, after `MUSIC_PLAYLIST_DELETE: Schemas["PlaylistDeleted"];`:

```ts
  WATCH_UPDATE: WatchUpdate;
```

In `store.ts`:
- Import `WatchState` and `WatchUpdate` from `./types`, next to `MusicState`.
- Add to `State`, after `music`:

```ts
  watch: Record<string, WatchState | null>; // by voice channel ID: null when nothing is on; absent until loaded or announced
  serverOffset: number; // server clock minus local clock (ms), from the last WATCH_UPDATE
```

- Add to `initialState`, after `music: {},`:

```ts
  watch: {},
  serverOffset: 0,
```

- Add a reducer case after the `MUSIC_UPDATE` case:

```ts
    case "WATCH_UPDATE": {
      const w = data as WatchUpdate;
      return { ...s, watch: { ...s.watch, [w.channel_id]: w.state ?? null }, serverOffset: w.server_now - Date.now() };
    }
```

In `client.ts`, import `WatchUpdate` from `./types` with the other types. Then add after `setMusicRepeat`:

```ts
  /** Loads what a voice channel watches together. */
  async getWatch(channelId: string): Promise<WatchUpdate> {
    const w = await unwrap(this.api.GET("/api/channels/{channelID}/watch", { params: { path: { channelID: channelId } } }));
    this.apply("WATCH_UPDATE", w);
    return w;
  }

  /** Starts watching a link together in a voice channel the caller is in, replacing what was on. */
  async startWatch(channelId: string, url: string) {
    this.apply("WATCH_UPDATE", await unwrap(this.api.POST("/api/channels/{channelID}/watch", { params: { path: { channelID: channelId } }, body: { url } })));
  }

  async watchPlay(channelId: string) {
    this.apply("WATCH_UPDATE", await unwrap(this.api.POST("/api/channels/{channelID}/watch/play", { params: { path: { channelID: channelId } } })));
  }

  async watchPause(channelId: string) {
    this.apply("WATCH_UPDATE", await unwrap(this.api.POST("/api/channels/{channelID}/watch/pause", { params: { path: { channelID: channelId } } })));
  }

  async watchSeek(channelId: string, position: number) {
    this.apply("WATCH_UPDATE", await unwrap(this.api.POST("/api/channels/{channelID}/watch/seek", { params: { path: { channelID: channelId } }, body: { position } })));
  }

  async stopWatch(channelId: string) {
    await unwrap(this.api.DELETE("/api/channels/{channelID}/watch", { params: { path: { channelID: channelId } } }));
  }
```

`stopWatch` doesn't apply a result, because a 204 has no body. The `WATCH_UPDATE` event with no state follows.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm --filter @datrope/core test`
Expected: PASS.

Run: `pnpm --filter @datrope/core typecheck`
Expected: no errors.

- [ ] **Step 5: Checkpoint (do not commit)**

Suggested message: `feat(core): watch-together client methods and store`.

---

### Task 5: Sync logic (pure)

**Files:**
- Create: `clients/web/src/app/watch/sync.ts`
- Test: `clients/web/src/app/watch/sync.test.ts`

**Interfaces:**
- Consumes from Task 4: the `WatchState` type, from `@datrope/core`.
- Produces:
  - `DRIFT_S = 1.5`
  - `expectedPosition(st, nowMs, offsetMs): number`
  - `type Sample = { time: number; playing: boolean; duration: number }`
  - `type Fix = { seek?: number; play?: true; pause?: true }`
  - `reconcile(st, sample, expected): Fix`
  - `formatTime(seconds): string`
  - `describeAction(st, name): string`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { DRIFT_S, describeAction, expectedPosition, formatTime, reconcile } from "./sync";

const yt = { kind: "youtube", paused: false, position: 10, updated_at: 1_000_000, last_action: "play" } as const;

describe("expectedPosition", () => {
  it("adds the time since the update while playing, on the server's clock", () => {
    expect(expectedPosition(yt, 1_004_000, 0)).toBe(14);
    expect(expectedPosition(yt, 1_002_000, 2_000)).toBe(14); // my clock is 2 s behind
    expect(expectedPosition(yt, 1_006_000, -2_000)).toBe(14); // 2 s ahead
  });
  it("stays put while paused, never goes back before the update, and is the position for live", () => {
    expect(expectedPosition({ ...yt, paused: true }, 1_009_000, 0)).toBe(10);
    expect(expectedPosition(yt, 999_000, 0)).toBe(10);
    expect(expectedPosition({ ...yt, kind: "twitch_live", position: 0 }, 1_009_000, 0)).toBe(0);
  });
});

describe("reconcile", () => {
  const sample = { time: 14, playing: true, duration: 600 };
  it("leaves a player in step alone", () => {
    expect(reconcile(yt, sample, 14)).toEqual({});
    expect(reconcile(yt, { ...sample, time: 14 + DRIFT_S }, 14)).toEqual({});
  });
  it("seeks past the drift threshold", () => {
    expect(reconcile(yt, { ...sample, time: 10 }, 14)).toEqual({ seek: 14 });
    expect(reconcile({ ...yt, kind: "twitch_vod" }, { ...sample, time: 30 }, 14)).toEqual({ seek: 14 });
  });
  it("never seeks a live stream", () => {
    expect(reconcile({ ...yt, kind: "twitch_live" }, { ...sample, time: 500 }, 0)).toEqual({});
  });
  it("matches play and pause", () => {
    expect(reconcile({ ...yt, paused: true }, sample, 14)).toEqual({ pause: true });
    expect(reconcile(yt, { ...sample, playing: false }, 14)).toEqual({ play: true });
  });
  it("does nothing once the video is over, instead of restarting it", () => {
    expect(reconcile(yt, { time: 600, playing: false, duration: 600 }, 640)).toEqual({});
    expect(reconcile(yt, { time: 0, playing: false, duration: 0 }, 4)).toEqual({ seek: 4, play: true }); // duration unknown yet
  });
});

describe("formatTime", () => {
  it("formats m:ss and h:mm:ss", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(61.9)).toBe("1:01");
    expect(formatTime(3723)).toBe("1:02:03");
  });
});

describe("describeAction", () => {
  it("says who did what", () => {
    expect(describeAction({ ...yt, last_action: "start" }, "Anna")).toBe("Anna started this");
    expect(describeAction({ ...yt, last_action: "play" }, "Anna")).toBe("Anna resumed");
    expect(describeAction({ ...yt, last_action: "pause" }, "bob")).toBe("bob paused");
    expect(describeAction({ ...yt, last_action: "seek", position: 761 }, "Max")).toBe("Max skipped to 12:41");
  });
});
```

- [ ] **Step 2: Run them to check they fail**

Run: `pnpm --filter @datrope/web test -- sync`
Expected: FAIL with "Failed to resolve import ./sync".

- [ ] **Step 3: Implement**

```ts
import type { WatchState } from "@datrope/core";

/** How far a player may drift from the shared position before it is seeked back (seconds). */
export const DRIFT_S = 1.5;

type Clocked = Pick<WatchState, "kind" | "paused" | "position" | "updated_at">;

/** Where playback should be now (seconds): the server's position, plus the time since on the server's clock while playing. */
export function expectedPosition(st: Clocked, nowMs: number, offsetMs: number): number {
  if (st.paused || st.kind === "twitch_live") return st.position;
  return st.position + Math.max(0, nowMs + offsetMs - st.updated_at) / 1000;
}

/** What a player reports. `duration` is 0 while unknown. */
export type Sample = { time: number; playing: boolean; duration: number };

/** What a player must do to match the shared state. */
export type Fix = { seek?: number; play?: true; pause?: true };

export function reconcile(st: Pick<WatchState, "kind" | "paused">, sample: Sample, expected: number): Fix {
  // Past the end: the video is over for everyone; seeking and playing would only restart it.
  if (st.kind !== "twitch_live" && sample.duration > 0 && expected >= sample.duration) return {};
  const fix: Fix = {};
  if (st.kind !== "twitch_live" && Math.abs(sample.time - expected) > DRIFT_S) fix.seek = expected;
  if (st.paused && sample.playing) fix.pause = true;
  if (!st.paused && !sample.playing) fix.play = true;
  return fix;
}

/** 61 → "1:01", 3723 → "1:02:03". */
export function formatTime(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The toast for someone else's last action: "Anna paused". */
export function describeAction(st: Pick<WatchState, "last_action" | "position">, name: string): string {
  switch (st.last_action) {
    case "start": return `${name} started this`;
    case "play": return `${name} resumed`;
    case "pause": return `${name} paused`;
    case "seek": return `${name} skipped to ${formatTime(st.position)}`;
  }
}
```

- [ ] **Step 4: Run them to check they pass**

Run: `pnpm --filter @datrope/web test -- sync`
Expected: PASS.

- [ ] **Step 5: Checkpoint (do not commit)**

Suggested message: `feat(web): watch-together sync logic`.

---

### Task 6: Player adapters, script loader, volume prefs

**Files:**
- Create: `clients/web/src/app/watch/load-script.ts`
- Create: `clients/web/src/app/watch/volume.ts`
- Create: `clients/web/src/app/watch/players/types.ts`
- Create: `clients/web/src/app/watch/players/youtube.ts`
- Create: `clients/web/src/app/watch/players/twitch.ts`
- Create: `clients/web/src/app/watch/players/index.ts`

**Interfaces:**
- Consumes: the `WatchState` type.
- Produces:
  - `loadScript(src): Promise<void>`
  - `readVolume(): WatchVolume`, `saveVolume(v)`, and `type WatchVolume = { volume: number; muted: boolean }`
  - The `WatchPlayer` interface and `PlayerEvents`
  - `createPlayer(mount: HTMLElement, st: WatchState, start: number, events: PlayerEvents): Promise<WatchPlayer>`

These adapters wrap third-party globals, so there are no unit tests. They are checked by the e2e test (Task 9, with a fake `window.YT`) and the manual browser check (Task 9, step 5). This task's gate is `typecheck` and `lint`.

- [ ] **Step 1: Write `load-script.ts`**

```ts
const loading = new Map<string, Promise<void>>();

/** Adds a script tag for `src` once; resolves when it has loaded. A failed load can be retried. */
export function loadScript(src: string): Promise<void> {
  let p = loading.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => {
        loading.delete(src);
        el.remove();
        reject(new Error(`could not load ${src}`));
      };
      document.head.appendChild(el);
    });
    loading.set(src, p);
  }
  return p;
}
```

- [ ] **Step 2: Write `volume.ts`**

```ts
const KEY = "datrope.watchVolume";

/** My volume for watch-together videos: mine alone, never shared with the call. */
export type WatchVolume = { volume: number; muted: boolean }; // volume 0-100

export function readVolume(): WatchVolume {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<WatchVolume> | null;
    if (v && typeof v.volume === "number") return { volume: Math.min(100, Math.max(0, v.volume)), muted: !!v.muted };
  } catch {
    // unreadable or blocked storage: the default
  }
  return { volume: 80, muted: false };
}

export function saveVolume(v: WatchVolume) {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    // blocked storage: the choice lasts until reload
  }
}
```

- [ ] **Step 3: Write `players/types.ts`**

```ts
import type { WatchState } from "@datrope/core";

/** An embedded player we drive ourselves; its own controls are hidden. */
export interface WatchPlayer {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  currentTime(): number;
  duration(): number; // 0 while unknown, and for live streams
  playing(): boolean; // playing or buffering towards playing
  setVolume(volume: number): void; // 0-100
  setMuted(muted: boolean): void;
  destroy(): void;
}

export interface PlayerEvents {
  onReady(): void;
  onError(message: string): void;
}

/** Builds a player inside `mount`, an element the caller created for it (players replace it). */
export type CreatePlayer = (mount: HTMLElement, st: WatchState, start: number, events: PlayerEvents) => Promise<WatchPlayer>;
```

- [ ] **Step 4: Write `players/youtube.ts`**

```ts
import { loadScript } from "../load-script";
import type { CreatePlayer } from "./types";

type YTPlayer = {
  playVideo(): void; pauseVideo(): void; seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime?(): number; getDuration?(): number; getPlayerState?(): number;
  setVolume(volume: number): void; mute(): void; unMute(): void; destroy(): void;
};
type YTNamespace = { Player: new (el: HTMLElement, options: object) => YTPlayer };

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let api: Promise<YTNamespace> | undefined;

/** YouTube's IFrame API, loaded once. */
function youtubeApi(): Promise<YTNamespace> {
  api ??= new Promise<YTNamespace>((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const before = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      before?.();
      resolve(window.YT!);
    };
    loadScript("https://www.youtube.com/iframe_api").catch((e: unknown) => {
      api = undefined;
      reject(e);
    });
  });
  return api;
}

const ERRORS: Record<number, string> = {
  2: "This link is not a valid video.",
  5: "The video cannot play here.",
  100: "The video is private or was removed.",
  101: "The video's owner does not allow playing it here.",
  150: "The video's owner does not allow playing it here.",
};

const PLAYING = 1;
const BUFFERING = 3;

export const createYouTube: CreatePlayer = async (mount, st, start, events) => {
  const YT = await youtubeApi();
  const p = new YT.Player(mount, {
    host: "https://www.youtube-nocookie.com", // the CSP's frame-src allows this host
    videoId: st.video_id,
    width: "100%",
    height: "100%",
    playerVars: { autoplay: st.paused ? 0 : 1, controls: 0, disablekb: 1, rel: 0, modestbranding: 1, playsinline: 1, iv_load_policy: 3, start: Math.floor(start) },
    events: {
      onReady: () => events.onReady(),
      onError: (e: { data: number }) => events.onError(ERRORS[e.data] ?? "The video cannot play."),
    },
  });
  return {
    play: () => p.playVideo(),
    pause: () => p.pauseVideo(),
    seek: (s) => p.seekTo(s, true),
    currentTime: () => p.getCurrentTime?.() ?? 0,
    duration: () => p.getDuration?.() ?? 0,
    playing: () => {
      const s = p.getPlayerState?.();
      return s === PLAYING || s === BUFFERING;
    },
    setVolume: (v) => p.setVolume(v),
    setMuted: (m) => (m ? p.mute() : p.unMute()),
    destroy: () => p.destroy(),
  };
};
```

- [ ] **Step 5: Write `players/twitch.ts`**

```ts
import { loadScript } from "../load-script";
import type { CreatePlayer } from "./types";

type TwitchPlayer = {
  play(): void; pause(): void; seek(seconds: number): void;
  getCurrentTime(): number; getDuration(): number; isPaused(): boolean;
  setVolume(volume: number): void; setMuted(muted: boolean): void;
  addEventListener(event: string, cb: () => void): void;
};
type TwitchNamespace = { Player: { new (elementId: string, options: object): TwitchPlayer; READY: string; OFFLINE: string } };

declare global {
  interface Window {
    Twitch?: TwitchNamespace;
  }
}

/** 3723 → "1h2m3s", Twitch's time format. */
const twitchTime = (seconds: number) => {
  const t = Math.floor(seconds);
  return `${Math.floor(t / 3600)}h${Math.floor((t % 3600) / 60)}m${t % 60}s`;
};

let next = 0;

export const createTwitch: CreatePlayer = async (mount, st, start, events) => {
  await loadScript("https://embed.twitch.tv/embed/v1.js");
  const T = window.Twitch!;
  const live = st.kind === "twitch_live";
  mount.id ||= `watch-twitch-${++next}`; // Twitch's player takes an element ID
  const p = new T.Player(mount.id, {
    width: "100%",
    height: "100%",
    parent: [location.hostname],
    autoplay: !st.paused,
    muted: false,
    controls: false,
    ...(live ? { channel: st.video_id } : { video: `v${st.video_id}`, time: twitchTime(start) }),
  });
  p.addEventListener(T.Player.READY, () => events.onReady());
  if (live) p.addEventListener(T.Player.OFFLINE, () => events.onError(`${st.video_id} is offline.`));
  return {
    play: () => p.play(),
    pause: () => p.pause(),
    seek: (s) => p.seek(s),
    currentTime: () => p.getCurrentTime(),
    duration: () => (live ? 0 : p.getDuration()),
    playing: () => !p.isPaused(),
    setVolume: (v) => p.setVolume(v / 100),
    setMuted: (m) => p.setMuted(m),
    destroy: () => mount.replaceChildren(), // Twitch's player has no destroy; dropping its iframe ends it
  };
};
```

- [ ] **Step 6: Write `players/index.ts`**

```ts
import { createTwitch } from "./twitch";
import type { CreatePlayer } from "./types";
import { createYouTube } from "./youtube";

/** The player for a watch's kind. */
export const createPlayer: CreatePlayer = (mount, st, start, events) =>
  (st.kind === "youtube" ? createYouTube : createTwitch)(mount, st, start, events);
```

- [ ] **Step 7: Typecheck and lint**

Run: `pnpm --filter @datrope/web typecheck`
Expected: no errors.

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 8: Checkpoint (do not commit)**

Suggested message: `feat(web): YouTube and Twitch player adapters`.

---

### Task 7: Sync hook and WatchTile

**Files:**
- Create: `clients/web/src/app/watch/use-watch-sync.ts`
- Create: `clients/web/src/app/watch/WatchTile.tsx`
- Create: `clients/web/src/app/watch/WatchDialog.tsx`

`WatchDialog` lives in this task because the tile's "Change" opens it.

**Interfaces:**
- Consumes:
  - From Task 4: `useApp((s) => s.watch[id])`, `s.serverOffset` and the `client.*Watch*` methods
  - From Task 5: `expectedPosition`, `reconcile`, `formatTime`, `describeAction`
  - From Task 6: `createPlayer`, `readVolume`, `saveVolume`
  - `TileSize` from `../voice/Tile`
  - `useVoice` from `../../voice/voice`
  - `userName` and `client` from `../../session`
- Produces:
  - `useWatchSync(channelId, host): { st, player, error, blocked, unblock }`
  - `<WatchTile channelId size />`, a `<section aria-label="Watch together">`
  - `<WatchDialog channelId initialUrl? onClose />`

- [ ] **Step 1: Write `use-watch-sync.ts`**

```ts
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../../session";
import { createPlayer } from "./players";
import type { WatchPlayer } from "./players/types";
import { expectedPosition, reconcile } from "./sync";

const TICK_MS = 2000;
const AUTOPLAY_GRACE_MS = 1500;

/** Mounts the player for a channel's watch inside `host` and keeps it in step with the server's state. */
export function useWatchSync(channelId: string, host: RefObject<HTMLDivElement>) {
  const st = useApp((s) => s.watch[channelId] ?? null);
  const offset = useApp((s) => s.serverOffset);
  const [player, setPlayer] = useState<WatchPlayer>();
  const [error, setError] = useState<string>();
  const [blocked, setBlocked] = useState(false);
  const stRef = useRef(st);
  stRef.current = st;
  const offsetRef = useRef(offset);
  offsetRef.current = offset;

  // A new player per video; play, pause and seek reuse it.
  const url = st?.url;
  useEffect(() => {
    const el = host.current;
    const cur = stRef.current;
    if (!el || !cur) return;
    let gone = false;
    let ready = false;
    let made: WatchPlayer | undefined;
    setError(undefined);
    setBlocked(false);
    const mount = document.createElement("div"); // the player replaces it; React never owns it
    el.appendChild(mount);
    createPlayer(mount, cur, expectedPosition(cur, Date.now(), offsetRef.current), {
      onReady: () => {
        ready = true;
        if (made && !gone) setPlayer(made);
      },
      onError: (m) => {
        if (!gone) setError(m);
      },
    }).then((p) => {
      made = p;
      if (gone) p.destroy();
      else if (ready) setPlayer(p);
    }, () => {
      if (!gone) setError("The player could not load.");
    });
    return () => {
      gone = true;
      made?.destroy();
      el.replaceChildren();
      setPlayer(undefined);
    };
  }, [url, host]);

  // Match the shared state now and every tick; seek only past the drift threshold.
  useEffect(() => {
    if (!player || blocked) return;
    const timers: number[] = [];
    const tick = () => {
      const cur = stRef.current;
      if (!cur) return;
      const expected = expectedPosition(cur, Date.now(), offsetRef.current);
      const fix = reconcile(cur, { time: player.currentTime(), playing: player.playing(), duration: player.duration() }, expected);
      if (fix.seek !== undefined) player.seek(fix.seek);
      if (fix.pause) player.pause();
      if (fix.play) {
        player.play();
        timers.push(window.setTimeout(() => {
          if (stRef.current && !stRef.current.paused && !player.playing()) setBlocked(true); // the browser blocked autoplay
        }, AUTOPLAY_GRACE_MS));
      }
    };
    tick();
    const interval = window.setInterval(tick, TICK_MS);
    return () => {
      window.clearInterval(interval);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [player, blocked, st]);

  /** "Click to sync": a click is the gesture the browser wants before playing with sound. */
  const unblock = () => {
    player?.play();
    setBlocked(false);
  };

  return { st, player, error, blocked, unblock };
}
```

- [ ] **Step 2: Write `WatchDialog.tsx`**

```tsx
import { useState, type FormEvent } from "react";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSubmit } from "@/hooks/use-submit";
import { client, useApp } from "../../session";

/** Starts a video for everyone in a voice channel, or changes what is on. */
export function WatchDialog({ channelId, initialUrl = "", onClose }: { channelId: string; initialUrl?: string; onClose: () => void }) {
  const name = useApp((s) => s.channels[channelId]?.name ?? "this channel");
  const [url, setUrl] = useState(initialUrl);
  const { busy, error, run } = useSubmit();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await client.startWatch(channelId, url.trim());
      onClose();
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Watch together</DialogTitle>
            <DialogDescription>
              Paste a YouTube video or a Twitch channel or VOD. Everyone in {name} watches it in sync, and anyone can pause, seek or change it.
            </DialogDescription>
          </DialogHeader>
          <Input aria-label="Video link" placeholder="https://youtu.be/…" value={url} autoFocus onChange={(e) => setUrl(e.target.value)} />
          <ErrorText error={error} />
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !url.trim()}>Start watching</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Write `WatchTile.tsx`**

```tsx
import { ArrowLeftRight, Pause, Play, Square, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useSubmit } from "@/hooks/use-submit";
import { cn } from "@/lib/utils";
import { client, useApp, userName } from "../../session";
import { useVoice } from "../../voice/voice";
import type { TileSize } from "../voice/Tile";
import { describeAction, expectedPosition, formatTime } from "./sync";
import { useWatchSync } from "./use-watch-sync";
import { readVolume, saveVolume } from "./volume";
import { WatchDialog } from "./WatchDialog";

const box: Record<TileSize, string> = {
  large: "size-full min-h-0",
  strip: "h-full aspect-video shrink-0",
  grid: "aspect-video",
};

const TOAST_MS = 3000;

/** Re-renders every second while `on`, for the time display. */
function useTicker(on: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [on]);
}

/** The call's shared video: the embedded player under our own controls, in step with everyone in the call. */
export function WatchTile({ channelId, size }: { channelId: string; size: TileSize }) {
  const host = useRef<HTMLDivElement>(null);
  const { st, player, error, blocked, unblock } = useWatchSync(channelId, host);
  const here = useVoice((v) => v.channelId === channelId && v.status === "connected");
  const meId = useApp((s) => s.me?.id);
  const offset = useApp((s) => s.serverOffset);
  const actor = useApp((s) => (st ? userName(s, st.last_actor) : ""));
  const [vol, setVol] = useState(readVolume);
  const [changing, setChanging] = useState(false);
  const [scrub, setScrub] = useState<number>(); // while the position slider is dragged
  const [toast, setToast] = useState<string>();
  const { busy, error: actError, run } = useSubmit();
  useTicker(!!st && !st.paused);

  // Someone else's action, said for a few seconds. A late title does not change updated_at, so it does not re-toast.
  const note = st && st.last_actor !== meId ? describeAction(st, actor) : undefined;
  const stamp = st?.updated_at;
  useEffect(() => {
    if (!note) return;
    setToast(note);
    const t = window.setTimeout(() => setToast(undefined), TOAST_MS);
    return () => window.clearTimeout(t);
  }, [note, stamp]);

  useEffect(() => {
    player?.setVolume(vol.volume);
    player?.setMuted(vol.muted);
    saveVolume(vol);
  }, [player, vol]);

  if (!st) return null;
  const live = st.kind === "twitch_live";
  const strip = size === "strip";
  const dur = player?.duration() ?? 0;
  const pos = Math.min(expectedPosition(st, Date.now(), offset), dur || Infinity);
  const act = (fn: () => Promise<void>) => void run(fn);
  const toggle = () => act(() => (st.paused ? client.watchPlay(channelId) : client.watchPause(channelId)));

  return (
    <section aria-label="Watch together" className={cn("group relative overflow-hidden rounded-xl border bg-sidebar", box[size])}>
      <div ref={host} className="absolute inset-0 [&>*]:size-full [&_iframe]:size-full" />
      {/* Covers the embed: its own controls would change playback for me alone. */}
      <div className="absolute inset-0" aria-hidden />
      <div className="absolute left-2.5 top-2.5 flex max-w-[70%] items-center gap-1.5">
        {live && <Badge variant="destructive">LIVE</Badge>}
        {!strip && <span className="truncate rounded-md bg-background/80 px-2 py-0.5 text-xs text-foreground">{st.title || st.url}</span>}
      </div>
      {toast && !strip && (
        <p role="status" className="absolute right-2.5 top-2.5 rounded-md border bg-popover px-2.5 py-1 text-xs text-popover-foreground shadow-md">{toast}</p>
      )}
      {blocked && (
        <button type="button" onClick={unblock} className="absolute inset-0 grid place-items-center bg-background/70 text-sm font-medium text-foreground">
          <span className="flex items-center gap-2"><Play className="size-5" aria-hidden />Click to sync</span>
        </button>
      )}
      {error && (
        <div role="alert" className="absolute inset-0 grid place-content-center justify-items-center gap-2 bg-background/90 p-4 text-center text-sm">
          <p>{error}</p>
          {here && <Button size="sm" variant="outline" onClick={() => setChanging(true)}>Change video</Button>}
        </div>
      )}
      {strip ? (
        <Button size="icon-sm" className="absolute bottom-1.5 left-1.5" aria-label={st.paused ? "Play" : "Pause"} disabled={!here || busy} onClick={toggle}>
          {st.paused ? <Play /> : <Pause />}
        </Button>
      ) : (
        <div role="toolbar" aria-label="Watch controls" className={cn(
          "absolute inset-x-0 bottom-0 grid gap-2 bg-gradient-to-t from-background/95 to-transparent px-3 pb-2.5 pt-8 transition-opacity",
          st.paused ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100",
        )}>
          {!live && dur > 0 && (
            <Slider aria-label="Position" min={0} max={dur} step={1} value={[scrub ?? pos]} disabled={!here}
              onValueChange={([v = 0]) => setScrub(v)}
              onValueCommit={([v = 0]) => {
                setScrub(undefined);
                act(() => client.watchSeek(channelId, v));
              }} />
          )}
          <div className="flex items-center gap-2">
            <Button size="icon-sm" aria-label={st.paused ? "Play" : "Pause"} disabled={!here || busy} onClick={toggle}>
              {st.paused ? <Play /> : <Pause />}
            </Button>
            {live
              ? <span className="text-xs font-semibold text-destructive">LIVE</span>
              : <span className="text-xs tabular-nums text-muted-foreground">{formatTime(scrub ?? pos)}{dur > 0 && ` / ${formatTime(dur)}`}</span>}
            {st.paused && st.last_action === "pause" && <span className="truncate text-xs text-muted-foreground">Paused by {actor}</span>}
            <span className="flex-1" />
            <Button size="icon-sm" variant="ghost" aria-label={vol.muted ? "Unmute video" : "Mute video"}
              onClick={() => setVol((v) => ({ ...v, muted: !v.muted }))}>
              {vol.muted ? <VolumeX /> : <Volume2 />}
            </Button>
            <Slider aria-label="Video volume" className="w-20" min={0} max={100} step={5} value={[vol.muted ? 0 : vol.volume]}
              onValueChange={([v = 0]) => setVol({ volume: v, muted: false })} />
            <Button size="sm" variant="outline" disabled={!here} onClick={() => setChanging(true)}><ArrowLeftRight />Change</Button>
            <Button size="sm" variant="outline" disabled={!here || busy} onClick={() => act(() => client.stopWatch(channelId))}><Square />Stop</Button>
          </div>
          <ErrorText error={actError} />
        </div>
      )}
      {changing && <WatchDialog channelId={channelId} initialUrl={st.url} onClose={() => setChanging(false)} />}
    </section>
  );
}
```

- [ ] **Step 4: Typecheck, lint and the unit tests**

Run: `pnpm --filter @datrope/web typecheck`, then `pnpm lint`, then `pnpm --filter @datrope/web test`.
Expected: all clean and passing.

If `popover-foreground` isn't a token utility, use `text-foreground`. `styles.css` defines `--color-popover-foreground`, so it should be fine.

- [ ] **Step 5: Checkpoint (do not commit)**

Suggested message: `feat(web): watch-together tile and dialog`.

---

### Task 8: Call integration (stage, grid, call controls, sidebar, loading)

**Files:**
- Create: `clients/web/src/app/watch/WatchControl.tsx`
- Modify: `clients/web/src/app/voice/CallControls.tsx`
- Modify: `clients/web/src/app/voice/StageView.tsx`
- Modify: `clients/web/src/app/voice/GridView.tsx`
- Modify: `clients/web/src/app/voice/VoiceStage.tsx`. This covers `useVoiceLayout` (lines 21–35) and `Call` (lines 61–120).
- Modify: `clients/web/src/app/voice/VoiceMembers.tsx`

**Interfaces:**
- Consumes from Task 7: `WatchTile` and `WatchDialog`.
- Consumes from Task 4: `client.getWatch` and `s.watch`.
- Consumes: `Control` from `../voice/VoicePanel`.
- Produces:
  - `<WatchControl className />`
  - `StageView` and `GridView` accept `watch?: (size: TileSize) => ReactNode`

- [ ] **Step 1: Write `WatchControl.tsx`**

```tsx
import { Tv } from "lucide-react";
import { useState } from "react";
import { useApp } from "../../session";
import { useVoice } from "../../voice/voice";
import { Control } from "../voice/VoicePanel";
import { WatchDialog } from "./WatchDialog";

/** The call control that starts a video for everyone in my voice channel, or changes what is on. */
export function WatchControl({ className }: { className?: string }) {
  const channelId = useVoice((v) => (v.status === "idle" ? undefined : v.channelId ?? undefined));
  const voiceChannel = useApp((s) => !!channelId && s.channels[channelId]?.type === "voice");
  const current = useApp((s) => (channelId ? s.watch[channelId] ?? null : null));
  const [open, setOpen] = useState(false);
  if (!channelId || !voiceChannel) return null; // DM calls have no watch-together
  return (
    <>
      <Control label="Watch together" tip={current ? "Change what everyone watches" : "Watch together"} className={className}
        pressed={!!current} onPressedChange={() => setOpen(true)}>
        <Tv />
      </Control>
      {open && <WatchDialog channelId={channelId} initialUrl={current?.url} onClose={() => setOpen(false)} />}
    </>
  );
}
```

- [ ] **Step 2: Add it to `CallControls.tsx`**

Import `WatchControl` from `"../watch/WatchControl"`, and put it right after `<ShareScreenControl className={toggle} />`:

```tsx
      <WatchControl className={toggle} />
```

- [ ] **Step 3: Let `StageView` put the watch on the stage**

Replace the function's props, the `main`/`rest` lines and the early return, and the large tile. The full new body:

```tsx
/** The shared video or the first watched screen share large, everyone else (and other watched shares) in a strip below. */
export function StageView({ entries, speaking, watching, chip, bot, watch, compact }: {
  entries: Entry[];
  speaking: string[];
  watching: string[];
  chip?: (e: Entry) => ReactNode;
  bot?: (size: TileSize) => ReactNode; // the music bot's tile, while it is in the call
  watch?: (size: TileSize) => ReactNode; // the shared video, while one is on: it takes the stage
  compact?: boolean;
}) {
  const main = watch ? undefined : entries.find((e) => isWatchedScreen(e, watching));
  const rest = entries.filter((e) => e !== main);
  const ref = useRef<HTMLDivElement>(null);
  if (!main && !watch) return null;
  const fullscreen = () => {
    // Denied or unsupported (e.g. iOS): nothing to do.
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else ref.current?.requestFullscreen?.()?.catch(() => {});
  };
  return (
    <div className={cn("grid gap-3", compact ? "h-[40vh] min-h-56 grid-rows-[minmax(0,1fr)_5rem]" : "h-full min-h-96 grid-rows-[minmax(0,1fr)_8rem]")}>
      {main ? (
        <Tile key={entryKey(main)} userId={main.userId} tile={main.tile} size="large" watching rootRef={ref} chip={chip?.(main)}>
          <div className="absolute right-2.5 top-2.5 flex gap-1.5">
            <Button variant="secondary" size="icon-sm" aria-label="Full screen" onClick={fullscreen}><Maximize /></Button>
            <Button variant="secondary" size="sm" onClick={() => voice.watch(main.userId, false)}><EyeOff /> Stop watching</Button>
          </div>
          <ScreenAudio userId={main.userId} />
        </Tile>
      ) : watch?.("large")}
      <div className="flex min-h-0 gap-3 overflow-x-auto py-1">
        {rest.map((e) => (
          <Tile key={entryKey(e)} userId={e.userId} tile={e.tile} size="strip" speaking={speaking.includes(e.userId)}
            watching={watching.includes(e.userId)} chip={chip?.(e)} />
        ))}
        {bot?.("strip")}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Let `GridView` show the watch first**

Add `watch` to the props. Its type is `watch?: (size: TileSize) => ReactNode; // the shared video, while one is on`. Then, after `if (bot) tiles.push(...)`, add:

```tsx
  if (watch) tiles.unshift(<Fragment key="watch">{watch("grid")}</Fragment>);
```

Update the doc comment to: `/** The shared video, every participant and screen share in a responsive grid, then the music bot, plus the invite tile in a small call. */`.

- [ ] **Step 5: Count the watch in `useVoiceLayout` and wire it in `Call`**

In `VoiceStage.tsx`, change the imports:
- `import { client, useApp, usePerms } from "../../session";`
- add `import { WatchTile } from "../watch/WatchTile";`

Replace `useVoiceLayout` with:

```tsx
/** The call's layout: watching a share or starting a shared video switches to the stage, stopping the last one returns to the grid. */
export function useVoiceLayout(channelId: string) {
  const watching = useVoice((v) => (v.channelId === channelId ? v.watching.length : 0));
  const watchOn = useApp((s) => !!s.watch[channelId]);
  const live = watching + (watchOn ? 1 : 0); // things worth the stage
  // Same check as the stage: a share of someone else that I'm watching, with its tile in the call.
  const canStageShare = useVoice((v) => v.channelId === channelId
    && v.tiles.some((t) => t.source === "screen" && !t.local && v.watching.includes(t.userId)));
  const canStage = canStageShare || watchOn;
  const [layout, setLayout] = useState<VoiceLayout>(live > 0 ? "stage" : "grid");
  const last = useRef({ channelId, live });
  useEffect(() => {
    const was = last.current.channelId === channelId ? last.current.live : 0;
    if (live > was) setLayout("stage");
    else if (live === 0) setLayout("grid");
    last.current = { channelId, live };
  }, [channelId, live]);
  return { layout: canStage ? layout : "grid", setLayout, canStage };
}
```

In `Call`, after the `bot` const, add:

```tsx
  const voiceChannel = useApp((s) => s.channels[channelId]?.type === "voice");
  const watchLoaded = useApp((s) => s.watch[channelId] !== undefined);
  const watchOn = useApp((s) => !!s.watch[channelId]);
  // Updates reach everyone who can see the channel; only the state at page load needs fetching.
  useEffect(() => {
    if (voiceChannel && !watchLoaded) void client.getWatch(channelId).catch(() => undefined);
  }, [voiceChannel, watchLoaded, channelId]);
  const watch = watchOn ? (size: TileSize) => <WatchTile channelId={channelId} size={size} /> : undefined;
```

Then change:
- `const stage = layout === "stage" && entries.some((e) => isWatchedScreen(e, watching));` to `const stage = layout === "stage" && (watchOn || entries.some((e) => isWatchedScreen(e, watching)));`
- `{(entries.length > 0 || bot) && (` to `{(entries.length > 0 || bot || watch) && (`
- Pass `watch={watch}` to both `<StageView ... />` and `<GridView ... />`.

- [ ] **Step 6: Add the sidebar line in `VoiceMembers.tsx`**

Add `Tv` to the `lucide-react` import. After the existing music `useEffect`, add:

```tsx
  const watchLoaded = useApp((s) => s.watch[channelId] !== undefined);
  const watchTitle = useApp((s) => {
    const w = s.watch[channelId];
    return w ? w.title || w.video_id : undefined;
  });
  useEffect(() => {
    if (occupied && !watchLoaded) void client.getWatch(channelId).catch(() => undefined);
  }, [occupied, watchLoaded, channelId]);
```

Both hooks must sit above `if (!occupied) return null;`.

Inside the `<ul>`, after the `{bot && (...)}` item, add:

```tsx
      {watchTitle !== undefined && (
        <li className="flex items-center gap-2 px-1 py-1 text-sm text-primary" title={`Watching ${watchTitle}`}>
          <Tv className="size-3.5 flex-none" aria-hidden />
          <span className="truncate">Watching · {watchTitle}</span>
        </li>
      )}
```

- [ ] **Step 7: Typecheck, lint and the unit tests**

Run: `pnpm typecheck`, then `pnpm lint`, then `pnpm test`.
Expected: all clean and passing. The existing `fit.test.ts` and `invite.test.ts` are untouched.

- [ ] **Step 8: Checkpoint (do not commit)**

Suggested message: `feat(web): watch together in the call's stage and controls`.

---

### Task 9: CSP, e2e, and a manual check with the real players

**Files:**
- Modify: `deploy/Caddyfile:25`
- Modify: `clients/web/e2e/chat.spec.ts`. Add the `FAKE_YT` constant near the other top-level constants (around line 10), and a step after the Go Live section ends. That's after the line `await expect(bobLounge.getByText("alice's screen", { exact: true })).toHaveCount(0);` that follows "Stop streaming", around line 414, and before `// Soundboard:`.

**Interfaces:** it consumes every accessible name from the Global Constraints.

- [ ] **Step 1: Allow the player scripts in the CSP**

In `deploy/Caddyfile` line 25, change `script-src 'self' 'wasm-unsafe-eval';` to:

```
script-src 'self' 'wasm-unsafe-eval' https://www.youtube.com https://embed.twitch.tv;
```

Leave the rest of the header as it is.

- [ ] **Step 2: Write the e2e step**

Add this near the top of `chat.spec.ts`, after `const OCEAN = ...`:

```ts
// Stands in for YouTube's IFrame API in the watch-together step: no network, and playback is just a clock.
const FAKE_YT = `window.YT = { Player: class {
  constructor(el, o) { this.t = o.playerVars.start || 0; this.s = -1; this.at = 0; el.dataset.fakeYt = o.videoId; setTimeout(() => o.events.onReady({ target: this }), 0); }
  time() { return this.s === 1 ? this.t + (Date.now() - this.at) / 1000 : this.t; }
  playVideo() { if (this.s !== 1) { this.at = Date.now(); this.s = 1; } }
  pauseVideo() { this.t = this.time(); this.s = 2; }
  seekTo(t) { this.t = t; this.at = Date.now(); }
  getCurrentTime() { return this.time(); } getPlayerState() { return this.s; } getDuration() { return 600; }
  setVolume() {} mute() {} unMute() {} destroy() {}
} }; window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady();`;
```

Add this after the Go Live section and before `// Soundboard:`:

```ts
  // Watch together: alice starts a YouTube video from the call controls; it takes bob's stage and shows in the sidebar;
  // bob pauses and alice is told; alice stops it for everyone.
  for (const p of [alice, bob]) {
    await p.route("https://www.youtube.com/iframe_api", (r) => r.fulfill({ contentType: "text/javascript", body: FAKE_YT }));
  }
  await aliceControls.getByRole("button", { name: "Watch together" }).click();
  const watchDialog = alice.getByRole("dialog", { name: "Watch together" });
  await watchDialog.getByLabel("Video link").fill("https://example.com/not-a-video");
  await watchDialog.getByRole("button", { name: "Start watching" }).click();
  await expect(watchDialog.getByRole("alert")).toContainText("paste a YouTube video");
  await watchDialog.getByLabel("Video link").fill("https://youtu.be/dQw4w9WgXcQ");
  await watchDialog.getByRole("button", { name: "Start watching" }).click();
  await expect(watchDialog).toHaveCount(0);
  const bobWatch = bobLounge.getByRole("region", { name: "Watch together" });
  await expect(bobWatch).toBeVisible();
  await expect(bob.getByRole("list", { name: "In voice: Lounge" }).getByText(/^Watching · /)).toBeVisible();
  await bobWatch.hover();
  await bobWatch.getByRole("button", { name: "Pause" }).click();
  const aliceWatch = aliceMain.getByRole("region", { name: "Watch together" });
  await expect(aliceWatch.getByRole("status")).toHaveText("bob paused");
  await expect(aliceWatch.getByRole("button", { name: "Play" })).toBeVisible(); // paused: the controls stay up
  await aliceWatch.getByRole("button", { name: "Stop" }).click();
  await expect(bobWatch).toHaveCount(0);
  await expect(bob.getByRole("list", { name: "In voice: Lounge" }).getByText(/^Watching · /)).toHaveCount(0);
```

- [ ] **Step 3: Run the e2e suite against the compose stack**

Run these:
- `docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml --env-file deploy/.env.e2e -p datrope-e2e up -d --build --wait`
- then `pnpm --filter @datrope/web e2e`

Expected: PASS. If it fails, read `playwright-report` or the trace before changing anything, and check that `getByRole("status")` matches only the toast inside `aliceWatch`.

Afterwards run `docker compose ... -p datrope-e2e down`.

- [ ] **Step 4: Run the full checks**

Run: `go -C server test -race ./...`, `pnpm typecheck`, `pnpm lint` and `pnpm test`.
Expected: all pass.

- [ ] **Step 5: Manual check with the real players under the real CSP**

The Vite dev server doesn't send Caddy's CSP, so use the e2e compose stack, which serves through `deploy/Caddyfile`, at `https://localhost`.

1. Open `https://localhost` in the built-in browser and register two users (or use two tabs as one user each). Create a voice channel and join it in both.
2. Start `https://www.youtube.com/watch?v=dQw4w9WgXcQ` and check:
   - It plays in both tabs, the native YouTube controls aren't clickable, and the scrubber works.
   - Pause in one tab pauses the other within about 2s.
   - `read_console_messages` with `onlyErrors` shows **no `Content Security Policy` violations**.
   - If the IFrame API pulls a script from another origin (it shouldn't: `www.youtube.com/s/player/...` is the same origin), add only that origin to `script-src` and say so in the checkpoint.
3. Click "Change" and start `https://www.twitch.tv/<any live channel>`. Check that it plays with the LIVE badge and no scrubber, and that there are no CSP errors.
4. Start a Twitch VOD (`https://www.twitch.tv/videos/<id>`). Check that seeking in one tab moves the other.
5. Leave the call in both tabs, rejoin, and check that nothing is on (the call emptied, so the state was cleared).
6. Take a screenshot of the stage with the video on and the strip below. Share it with the user.

- [ ] **Step 6: Checkpoint (do not commit)**

Suggested message: `feat: watch together, CSP and e2e`. Report the results of the manual check, including any CSP origin you had to add.
