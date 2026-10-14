# Watch together: design

Date: 2026-10-14. Mockups: `docs/superpowers/mockups/WatchTogether.html` (concept **A, stage tile**, was chosen; B and C were rejected).

## Goal

People in a voice channel can watch a YouTube video, a Twitch VOD or a live Twitch stream together. Everyone sees the same thing at roughly the same moment, and anyone in the call can play, pause, seek, change or stop it.

## Decisions

- **Placement:** voice channels only. A watch belongs to a voice channel, in the same way the music bot does.
- **Control:** anyone who is in the voice channel can act. A toast and a line in the control bar say who did the last thing ("Max paused").
- **One item at a time.** There is no queue. Starting a new link replaces the current one.
- **Players:** the official YouTube IFrame API and the Twitch Embed JS, driven from our own control bar. The server keeps the clock and clients correct their own drift. There is no server-side restream.
- **Sources:** YouTube videos (including watch, `youtu.be`, `shorts` and `live` links), Twitch channels (live) and Twitch VODs. Twitch clips are out of scope.
- **UI:** a tile in the call. Starting a watch pins it to the stage. It is started from a new "Watch together" button in the call controls.

## Server: `server/internal/watch`

This is a new package, wired in `server/internal/app/app.go` next to `music`. It has no database, no migration and no audit entries. The state lives in memory and is lost on restart, which is acceptable: people start the watch again.

```go
type WatchState struct {
    ChannelID  id.ID   `json:"channel_id"`
    URL        string  `json:"url"`                 // canonical link
    Kind       string  `json:"kind" enum:"youtube,twitch_live,twitch_vod"`
    VideoID    string  `json:"video_id"`            // YouTube id, Twitch login, or VOD id
    Title      string  `json:"title,omitempty"`     // best effort, from linkpreview
    Paused     bool    `json:"paused"`
    Position   float64 `json:"position"`            // seconds at UpdatedAt; always 0 for twitch_live
    UpdatedAt  int64   `json:"updated_at"`          // server ms
    StartedBy  id.ID   `json:"started_by"`
    LastActor  id.ID   `json:"last_actor"`
    LastAction string  `json:"last_action" enum:"start,play,pause,seek"`
}

// The WATCH_UPDATE payload.
type WatchUpdate struct {
    ChannelID id.ID       `json:"channel_id"`
    State     *WatchState `json:"state"`      // null: the watch stopped
    ServerNow int64       `json:"server_now"` // ms, for the client's clock offset
}
```

- The service holds `map[id.ID]*WatchState` behind a mutex.
- **Where the playback is:** `pos(st, now) = st.Position + (now - st.UpdatedAt)/1000` while playing, and `st.Position` while paused. Every action first folds the current position into `Position` and `UpdatedAt`.

### Endpoints (Huma, tag `watch`)

| Method | Path | Body | Effect |
|---|---|---|---|
| GET | `/api/channels/{channelID}/watch` | | Returns a `WatchUpdate`, whose state is null when nothing is on. It needs view access to the channel. Clients call it when a voice channel's call is shown, the same way `get-music` is used. |
| POST | `/api/channels/{channelID}/watch` | `{url}` | Starts or replaces the watch: it is playing, at position 0 (a VOD link with `?t=` starts at that time). |
| POST | `/api/channels/{channelID}/watch/play` | | Resumes playback. |
| POST | `/api/channels/{channelID}/watch/pause` | | Pauses playback. |
| POST | `/api/channels/{channelID}/watch/seek` | `{position}` | Sets the position. It is rejected for `twitch_live`. |
| DELETE | `/api/channels/{channelID}/watch` | | Stops the watch. |

- Every POST and DELETE requires the caller to be in that voice channel right now, through `Voice.States`, the same way music's `inChannel` works. Otherwise it returns 403 `NOT_IN_CHANNEL`.
- The channel must be a voice channel. Otherwise it returns 400.
- Play, pause, seek or stop with nothing on returns 400 `NOTHING_PLAYING`.
- A link that isn't recognised returns 400 `UNSUPPORTED_LINK`.
- Seek on a live stream returns 400 `NOT_SEEKABLE`.
- A seek position below 0 becomes 0. There is no upper clamp, because the server does not know the duration.
- Play while already playing, or pause while paused, changes nothing and returns 200, but still publishes.
- Each successful action publishes `WATCH_UPDATE` to `Scope{ChannelID}`, which reaches everyone who can view the channel. That way the sidebar line "Watching · xQc" also shows to people who are not in the call.

### Link parsing (`watch/links.go`)

This is a pure function, `Parse(url) (kind, videoID string, start float64, err error)`, and it is table-tested. It mirrors the YouTube and Twitch rules in `clients/web/src/lib/players.ts`:

- **YouTube:** `youtube.com/watch?v=`, `youtu.be/`, `/shorts/`, `/live/`, `/embed/`, plus `m.` and `music.` hosts. It reads `t` or `start` as the start time.
- **Twitch:**
  - `twitch.tv/videos/{id}` is a `twitch_vod`, with `?t=1h2m3s` read as the start time.
  - `twitch.tv/{login}` (excluding reserved paths such as `directory`, `videos` and `settings`) is `twitch_live`.
- The canonical URL is rebuilt from the kind and the id.

### Title

After a start, the title is filled in with the existing `linkpreview` fetcher, best effort: a goroutine with a 5s timeout updates the state and publishes again. A failed lookup leaves the title empty, and clients then show the URL instead.

### Lifecycle

- The service calls `Bus.Subscribe` to watch `VOICE_STATE_UPDATE`.
- `Bus.Publish` is synchronous, and voice publishes while holding its own lock. So the subscriber only notes the channel ID and hands the check to a goroutine.
- That goroutine calls `Voice.States([ch])`. If nobody is left, it deletes the state and publishes `WATCH_UPDATE{state: null}`.

### OpenAPI

`WatchUpdate` is registered in `registerEventSchemas` (`server/internal/app/realtime.go`). Then `clients/core/openapi.json` and `schema.d.ts` are regenerated.

## Client core (`clients/core`)

- **Types:** `WatchState` and `WatchUpdate` in `types.ts`.
- **`client.ts` methods:**
  - `getWatch(ch)`
  - `startWatch(ch, url)`
  - `watchPlay(ch)`
  - `watchPause(ch)`
  - `watchSeek(ch, position)`
  - `stopWatch(ch)`
- **Store:** a new `watch: Record<channelId, WatchState>` and `serverOffset: number`.
  - The `WATCH_UPDATE` reducer sets or deletes `watch[channel_id]`, and sets `serverOffset = server_now - Date.now()`.
  - The `getWatch` result goes through the same reducer path.

## Web client (`clients/web/src/app/watch/`)

### Pure logic, `sync.ts` (with `sync.test.ts`)

- `expectedPosition(state, nowMs, offsetMs): number` uses the formula above, with `now = nowMs + offsetMs`.
- `reconcile(state, sample: {time, playing}, expected) → { seek?: number, play?: true, pause?: true }`:
  - It matches play and pause.
  - For `youtube` and `twitch_vod` it seeks when `|time - expected| > 1.5` (the constant `DRIFT_S`).
  - It never seeks `twitch_live`.

### Player adapters, `players/youtube.ts` and `players/twitch.ts`

```ts
interface WatchPlayer {
  play(): void; pause(): void; seek(s: number): void;
  currentTime(): number; playing(): boolean;
  setVolume(v: number /* 0-100 */): void; setMuted(m: boolean): void;
  destroy(): void;
  onReady(cb: () => void): void; onError(cb: (msg: string) => void): void; onAutoplayBlocked(cb: () => void): void;
}
```

- **Lazy script loading:** `loadScript(src)` loads each SDK once and returns a promise.
- **YouTube:**
  - It loads `https://www.youtube.com/iframe_api`.
  - The player is `new YT.Player(el, { host: "https://www.youtube-nocookie.com", videoId, playerVars: { controls: 0, disablekb: 1, rel: 0, modestbranding: 1, playsinline: 1, start } })`.
  - It reports errors 100, 101 and 150 ("unavailable or can't be embedded").
- **Twitch:**
  - It loads `https://embed.twitch.tv/embed/v1.js`.
  - The player is `new Twitch.Player(el, { channel | video, parent: [location.hostname], controls: false, autoplay: true, muted: false, time })`.
  - The Twitch time format is `1h2m3s`.
- **Autoplay:** if the player hasn't started about 1.5s after a play was requested, the adapter fires `onAutoplayBlocked`.

### `useWatchSync(channelId, player)` hook

- It runs `reconcile` after every `WATCH_UPDATE` and every 2s on a timer.
- It does nothing until the player is ready, and does nothing while the autoplay overlay is up.

### `WatchTile.tsx`

This tile sits in the call next to `MusicTile`, with sizes `large`, `strip` and `grid`.

- **Video area:**
  - The embed fills the tile.
  - A transparent overlay over the embed takes all pointer events, so the native embed UI can't be clicked. All control goes through our bar.
  - Top left: a `LIVE` badge (destructive) for `twitch_live`, or a source badge with the title.
  - Top right: a toast for the last action by someone else ("Anna paused"), shown for 3s.
- **Control bar:** the bottom of the tile on hover or focus, always shown while paused.
  - Play/pause (primary icon button).
  - YouTube and VOD: a scrubber (shadcn `Slider`) showing `mm:ss / mm:ss`, with the duration read from the player. Releasing it calls `watchSeek`.
  - Live: a `LIVE` label in place of the scrubber.
  - Local volume slider and mute. These are per person and kept in `localStorage`, not synced.
  - "Change" opens the start dialog with the URL filled in.
  - "Stop".
  - The pin/unpin toggle.
  - The buttons are disabled while I'm not connected to the call, the same way `MusicTile` uses `here`.
- **Strip size:** just the video with a play/pause button.
- **Overlays:**
  - Autoplay blocked: "Click to sync" fills the tile, and one click calls `player.play()` and reconciles.
  - Load error: an inline error with the message and a "Change" button. The server state is not touched.

### Stage and layout (`VoiceStage.tsx`)

- The watch tile is one of the stage's entries. `useVoiceLayout` treats an active watch like a watched screen share:
  - When a watch starts in my channel, the layout switches to `stage` with the watch tile pinned.
  - When it stops and nothing else is pinned, the layout goes back to `grid`.
  - Unpinning keeps the tile in the grid.
- The rest of the call stays in the strip under the stage, as with screen shares today.

### Start dialog (`WatchDialog.tsx`)

- shadcn `Dialog` with the title "Watch together" and one URL `Input` (`aria-label="Video link"`).
- The help text reads: "Paste a YouTube video or a Twitch channel or VOD. Everyone in {channel} watches it in sync, and anyone can pause, seek or change it."
- Buttons: Cancel, and "Start watching" (submit, through `useSubmit`).
- Server errors show with `ErrorText`.

### Call controls (`CallControls.tsx`)

A new round "Watch together" toggle (`Tv` icon, `aria-label="Watch together"`) sits next to Go Live:
- With nothing on, it opens the dialog.
- While a watch is on, it shows as pressed and opens the dialog to change the video.

### Sidebar

Under a voice channel with an active watch, the sidebar adds a line with the `Tv` icon and "Watching · {title or channel}" in `text-primary`. It shows to anyone who can view the channel.

### Data loading

When a voice channel's call is shown, the client calls `getWatch` once (alongside the existing `getMusic`). After that it relies on `WATCH_UPDATE`.

## CSP

In `deploy/Caddyfile`, `script-src` adds `https://www.youtube.com https://embed.twitch.tv`. `frame-src` already allows `www.youtube-nocookie.com` and `player.twitch.tv`.

During implementation, check in the browser that the YouTube API's player script (`www.youtube.com/s/player/...`) and Twitch's iframe load with only these additions, and add the smallest further origin if they don't.

The desktop app (Tauri) loads the server's origin, so the same CSP and Twitch's `parent` apply there too.

## Error handling summary

| Case | Behaviour |
|---|---|
| Bad or unsupported link | 400, and the dialog shows the error |
| Not in the call | 403, and the controls are disabled anyway |
| Video private, removed or not embeddable | Per-client error overlay; anyone can change the video |
| Autoplay blocked | "Click to sync" overlay |
| A viewer buffering or behind | A drift seek every 2s or less, and nobody waits for them |
| Video ends | The player shows its end screen; the expected position keeps going past the end, which is harmless |
| Server restart | The watch is gone; clients get null from the next `getWatch`, or after reconnecting |
| Everyone leaves the call | The state is cleared and null is published |

## Testing

- **Go:**
  - `links_test.go`: a table of URLs, with kinds, ids and start times.
  - `watch_test.go`:
    - start, pause, play and seek round-trips and their positions, with an injectable clock
    - 403 when not in the channel
    - `NOT_SEEKABLE` for live
    - clearing when the channel empties, with a fake `Voice` and the bus
- **Core:** a reducer test for `WATCH_UPDATE` set, clear and `serverOffset`.
- **Web unit:** `sync.test.ts` for `expectedPosition` and `reconcile` (drift threshold, live never seeks, play and pause matching).
- **e2e (Playwright, `clients/web/e2e`):**
  - Two users in a voice channel; one starts a YouTube link through the dialog; the other sees the tile on the stage and the sidebar line; the second pauses and the first sees the "paused" state and toast; stop clears it.
  - The embeds are stubbed: `window.YT` is a fake set through `page.addInitScript`, and the script route is intercepted, so the tests make no network calls.

## Out of scope (possible later)

- A "Watch together" button on chat link previews (from mockup C).
- A theater or fullscreen mode (from mockup B).
- A queue, Twitch clips and other sites.
- Host-only control or permissions.
- Group pause while someone is buffering.
