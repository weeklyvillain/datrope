# Stream settings, Go Live dialog and live source swap — design

Date: 2026-10-10. Scope: `clients/web` only, no backend or LiveKit server changes.

## Goals

1. Screen shares look good for gameplay: high frame rate and smooth motion by default.
2. A styled **Go Live** dialog to pick mode, resolution, frame rate and audio before sharing.
3. A **Game / Detail** mode toggle.
4. While live: change the source, quality and audio without stopping the stream.

Context: today `voice.ts` calls `setScreenShareEnabled(..., { audio: true })` with LiveKit defaults
(1080p, 15 fps, 2.5 Mbps, VP8, simulcast). Viewers with `adaptiveStream` can end up on a low layer.

## Out of scope

- A custom source picker (screens/windows/games with thumbnails). Browsers only offer their own
  `getDisplayMedia` dialog; a custom picker needs a desktop app with native capture. The browser picker
  still chooses the source; this design only adds our dialog in front of it.
- Admin limits on stream quality. Anyone with `STREAM` can pick any preset up to 1080p60.
- 1440p / "Source" presets.
- Camera settings (cameras keep LiveKit defaults and simulcast).

## 1. Settings

New `voice/stream-prefs.ts`, a device-only store following the `voice/prefs.ts` pattern
(zustand vanilla store, `localStorage` key `datrope.streamPrefs`, every stored value validated on load,
invalid or missing values fall back to the default):

```ts
export type StreamMode = "game" | "detail";
export interface StreamSettings {
  mode: StreamMode;
  resolution: 720 | 1080;
  fps: 30 | 60;
  audio: boolean;
}
```

- Default: `{ mode: "game", resolution: 1080, fps: 60, audio: true }`.
- Picking a mode in the UI also sets its default resolution and fps: Game → 1080p60, Detail → 1080p30.
  Resolution and fps can then still be changed by hand.
- The store keeps the last settings used to go live; the dialog opens with them.

## 2. Encoding

Pure function `encoding(s: StreamSettings)` in `voice/stream-prefs.ts` returning what LiveKit and the
browser need:

| | 720p30 | 720p60 | 1080p30 | 1080p60 |
|---|---|---|---|---|
| `maxBitrate` | 3 Mbps | 4.5 Mbps | 5 Mbps | 10 Mbps |

- `width`/`height`: 1280×720 or 1920×1080; `maxFramerate` = `fps`.
- Game: `contentHint: "motion"`, `degradationPreference: "maintain-framerate"`
  (under pressure resolution drops, fps holds).
- Detail: `contentHint: "detail"`, `degradationPreference: "maintain-resolution"`
  (text stays sharp, fps drops).
- Screen share video is published with `videoCodec: "h264"` (hardware encoding where the browser has it)
  and `simulcast: false`, so every viewer gets the one full-quality layer. Trade-off accepted: a viewer on
  a weak connection sees stutter rather than a lower resolution.
- Viewers need no change: with a single layer `adaptiveStream` has nothing lower to switch to; it still
  pauses video that is not visible.

## 3. Voice connection (`voice/voice.ts`)

`toggleScreen()` is replaced by:

- **`startScreen(s)`** — `createLocalScreenTracks({ audio: s.audio, resolution: { width, height, frameRate }, contentHint })`,
  then `publishTrack` the video as `Track.Source.ScreenShare` with the codec, `simulcast: false`,
  `videoEncoding: { maxBitrate, maxFramerate }` and `degradationPreference` from `encoding(s)`, and the
  audio track (if any) as `Track.Source.ScreenShareAudio`. Closing the browser picker (`NotAllowedError`)
  stays silent; other failures set "Could not share your screen.".
- **`changeSource()`** — opens the browser picker again with the current settings and swaps the new
  video into the published track with `LocalVideoTrack.replaceTrack()` (same publication, so viewers stay
  subscribed and "watch" state is kept). Audio follows the new source: new audio + audio published →
  replace; new audio + none published → publish; no new audio → unpublish the old audio. The old capture
  tracks are stopped. Closing the picker keeps the current source.
- **`applyStream(s)`** — live changes: `applyConstraints({ width, height, frameRate })` on the capture
  track, set `contentHint`, and `sender.setParameters` for `maxBitrate`, `maxFramerate` and
  `degradationPreference`. Audio off → unpublish the screen audio track. Audio on while no screen audio
  is published → calls `changeSource()` (only a new capture can add audio).
- **`stopScreen()`** — unpublishes and stops the screen tracks. The browser's own "Stop sharing" bar
  keeps working through LiveKit's `ended` handling.

The store gains `stream?: StreamSettings` — what is being sent now, `undefined` when not live — so the UI
shows the live values, not the saved defaults. `screen` stays as it is.

Errors: if a live change fails (some browsers refuse 60 fps for window capture), the previous settings
are re-applied, the stream keeps going, `stream` keeps its previous value and the error
"Could not apply stream settings." is shown. A failed source change shows "Could not change what you share."
and keeps the current source.

## 4. UI

Missing shadcn components (`toggle-group`) are added with the shadcn CLI first; tokens only, no `dark:`.

**Go Live dialog** — `app/voice/GoLiveDialog.tsx` (shadcn `Dialog`):
- Mode: two selectable cards, "Game" ("Smooth motion, 60 fps") and "Detail" ("Sharp text, for code and
  documents").
- Resolution (720p / 1080p) and Frame rate (30 / 60) as `ToggleGroup`s, "Share audio" as a `Switch`.
- Footer: Cancel, Go Live. Go Live saves the settings to `stream-prefs` and calls `startScreen`.
- Opened by the voice panel's "Share screen" button when not live.

**Stream menu** — `app/voice/StreamMenu.tsx` (shadcn `Popover`), shown when live:
- Change source, the same mode / resolution / frame rate / audio controls (applied at once through
  `applyStream`), and Stop streaming (destructive).
- Opened by the "Share screen" button while live and by a gear button on my own screen tile.
- The "Share screen" button keeps its accessible name so existing e2e selectors keep working.

## 5. Testing

- Vitest: `encoding()` for all four presets and both modes; `stream-prefs` load with missing, partial
  and invalid stored values; mode defaults.
- Playwright (Chrome fake media flags plus `--auto-select-desktop-capture-source=Entire screen`):
  open the dialog, pick Detail, Go Live, see my screen tile; open the stream menu, Change source: the local
  capture changes while the viewer keeps receiving video (the publication stays); Stop streaming removes the tile.
- Manual: a real game at 1080p60, checking sent fps, resolution and bitrate in `chrome://webrtc-internals`.
