# Voice audio settings and connection quality — design

Date: 2026-10-10. Scope: `clients/web` only. No server or `clients/core` changes.

## Goal

In a voice call, a user can:

- see whether their connection is good
- pick their microphone and speakers
- choose between voice activity and push to talk
- set how loud they must be before the mic opens
- remove background noise such as keyboard typing

## Decisions

- **Connection quality: mine only.** Round-trip time to the LiveKit SFU, packet loss and jitter from
  WebRTC stats, shown as signal bars in the voice panel. Per-participant quality on tiles and a debug
  panel are out of scope (possible follow-ups).
- **Settings live on this device** (localStorage), never sent to the server. Devices differ per machine.
- **Input mode is Discord-style:** voice activity (default) or push to talk.
- **Push to talk works only while the tab has focus.** There is no desktop app, and browsers have no
  global hotkeys.
- **Noise suppression: Off / Standard / Enhanced.**
  - Standard is the browser's built-in suppression.
  - Enhanced is RNNoise WASM in an AudioWorklet, via `@sapphi-red/web-noise-suppressor` (MIT).
  - Krisp is not an option: it needs LiveKit Cloud, and we self-host.
- **Audio processing runs in a LiveKit `TrackProcessor`** attached to the microphone track.
  - LiveKit keeps owning capture, device switching, reconnects and mute.
  - We do not publish our own track.
  - We do not gate by muting the publication: signalling round trips clip words and make the speaking
    indicator flicker.

## Units

All new modules live in `clients/web/src/voice/`.

### `audio-prefs.ts`: device-local audio settings

A zustand vanilla store saved under localStorage key `datrope.audioPrefs`, with the same defensive load
and in-memory fallback as `prefs.ts`.

| Field | Type | Default |
|---|---|---|
| `inputDeviceId` | string | `"default"` |
| `outputDeviceId` | string | `"default"` |
| `mode` | `"vad" \| "ptt"` | `"vad"` |
| `vadAuto` | boolean | `true` |
| `vadThresholdDb` | number, clamped to -100..0 | `-50` |
| `pttKey` | `{ code: string; label: string }`, where `code` is a `KeyboardEvent.code` and `label` is `e.key` at capture time, for display | `{ code: "Backquote", label: "`" }` |
| `noise` | `"off" \| "standard" \| "enhanced"` | `"standard"` |

Exports: `audioPrefs` (the store), `useAudioPrefs(selector)`, and one setter per field.

### `gate.ts`: pure gate logic (no Web Audio)

`createGate()` returns `{ update(input): boolean; currentThresholdDb(): number }`, where input is
`{ levelDb, nowMs, mode, pttDown, auto, thresholdDb }`.

- **VAD:** opens when `levelDb >= threshold`. It closes once the level has stayed below the threshold for
  300 ms (hold).
- **PTT:** open while `pttDown`. It closes 200 ms after release. The level is ignored.
- **Auto threshold:** keeps a noise-floor estimate. The floor follows falling levels quickly and rising
  levels slowly, so speech does not drag it up. The effective threshold is the floor plus 15 dB, clamped to
  -70..-20 dB.
- `currentThresholdDb()` returns the effective threshold, so the meter can show where auto put it.

### `mic-processor.ts`: the LiveKit TrackProcessor

Implements `TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>` (`name`, `init`, `restart`,
`destroy`, `processedTrack`). The chain on the 48 kHz AudioContext is:

```
MediaStreamSource → [RNNoise AudioWorkletNode, Enhanced only] → AnalyserNode (meter)
                  → GainNode (gate) → MediaStreamDestination → processedTrack
```

- A 20 ms timer reads the RMS level in dBFS from the analyser and feeds it to the gate.
- When the gate's decision changes, the gate gain ramps to 1 or 0 over about 10 ms using
  `setTargetAtTime`, which avoids clicks.
- Its API:
  - `setOptions({ mode, auto, thresholdDb, enhanced })`
  - `setPtt(down)`
  - `meter(): { db, open, thresholdDb }`
- If `enhanced` changes while it is running, it rebuilds the chain.
- If the RNNoise worklet or WASM fails to load, it builds without RNNoise and sets `enhancedFailed`.
- The RNNoise worklet and WASM are loaded only when Enhanced is first used (dynamic import plus Vite
  `?url` assets).

`createMicTest(deviceId, opts)` builds the same chain on its own `getUserMedia` stream, for the settings
page outside a call.

- It has an optional monitor ("Hear yourself") that routes the output to an `<audio>` element using
  `setSinkId(outputDeviceId)`.
- It returns `{ meter, setOptions, setMonitor, stop }`.

### `ptt.ts`: push-to-talk key listener

`watchPtt(target: EventTarget, getCode: () => string, onChange: (down: boolean) => void): () => void`.

- Matches `e.code === getCode()` and ignores `e.repeat`.
- Ignores keydown when the target is `input`, `textarea`, `select` or contenteditable. This is checked on
  keydown only, so a release is always seen.
- Calls `onChange(false)` on `blur` and on `visibilitychange` to hidden, so the mic never sticks open.

### `stats.ts`: connection quality

`readQuality(reports, prev?): Sample | undefined` is pure:

- **RTT** comes from the nominated, succeeded `candidate-pair`'s `currentRoundTripTime`.
- **When publishing,** loss and jitter come from the audio `remote-inbound-rtp` (`fractionLost`,
  `jitter`).
- **Otherwise** they come from audio `inbound-rtp`: the `packetsLost` / `packetsReceived` delta against
  `prev`, and `jitter`.

`rate(samples: Sample[]): Quality` averages the last 3 samples, then takes the worst of the three metrics:

| Rating | RTT | Loss | Jitter |
|---|---|---|---|
| good | < 100 ms | < 1 % | < 20 ms |
| ok | < 250 ms | < 5 % | < 50 ms |
| poor | otherwise | | |
| unknown | no samples | | |

`watchQuality(room, onQuality): () => void` polls every 2 s.

- It reads the local mic track's `getRTCStatsReport()` while publishing.
- Otherwise it reads the subscribed remote audio tracks' reports.
- Failures give `unknown`. Errors never reach the UI.

## Changes to existing code

### `voice/voice.ts`

- `new Room({...})` gains `audioCaptureDefaults` built from audio prefs:
  - `deviceId`
  - `noiseSuppression: noise === "standard"`
  - `echoCancellation: true`, `autoGainControl: true`
- After `setMicrophoneEnabled(true)`, it attaches a `MicProcessor` to the mic track with `setProcessor`.
- While connected, it subscribes to `audioPrefs`:
  - **Input device:** `room.switchActiveDevice("audioinput", id)`. On failure it switches back to
    `"default"` and sets `error: "Couldn't use <label>, using default."`.
  - **Output device:** `room.switchActiveDevice("audiooutput", id)`, only when supported.
  - **Noise:** `track.restartTrack({ ...constraints, noiseSuppression })` when the built-in flag changes.
    Then it updates the processor's `enhanced`.
  - **Mode, auto, threshold:** `processor.setOptions(...)`.
- It runs `watchPtt(window, …)` while connected and forwards to `processor.setPtt`.
- `VoiceView` gains
  `quality: { rating: "good" | "ok" | "poor" | "unknown"; rttMs?: number; lossPct?: number; jitterMs?: number }`.
  It is fed by `watchQuality` while connected and reset on disconnect.
- If the processor throws, it calls `track.stopProcessor()` and the raw mic continues.
- Mute is unchanged: it unpublishes the mic, so the gate only matters while unmuted.
- Exposes `voice.micMeter()`, which returns the processor's `meter()` (or `undefined`), for the settings
  meter during a call.

### Other files

- **`voice/soundboard-audio.ts` and `sounds`:** call `el.setSinkId(outputDeviceId)` when supported, so
  soundboard clips and call sounds follow the output device.
- **`app/settings/settings-store.ts` and `UserSettingsDialog.tsx`:** add the `"voice"` section, labelled
  "Voice & audio", after Notifications.
- **`app/voice/VoicePanel.tsx`:** add `ConnectionQuality` next to the status text while `connected`.

## UI

### `app/settings/VoiceSettings.tsx`

Built from shadcn primitives: `Select`, `Slider`, `RadioGroup`, `Switch`, `Button`, `Label`, `Tooltip`.

- Missing components are added with `pnpm dlx shadcn@latest add`, falling back to fetching the registry
  JSON on this machine.
- Only design tokens are used; there are no `dark:` variants.

The section is laid out in this order:

1. **Input device / Output device.** Two `Select`s listing devices from `enumerateDevices`, refreshed on
   `devicechange`.
   - Without mic permission, labels are empty. The list then shows "Default" plus an "Allow microphone
     access" button, which runs `getUserMedia` once and then stops it.
   - A saved device that is missing shows as "Default", but the saved ID is kept.
   - The output select is hidden when `AudioContext.prototype.setSinkId` does not exist.
2. **Input mode.** A `RadioGroup` with "Voice activity" and "Push to talk".
3. **Input sensitivity** (VAD only):
   - An "Automatically determine input sensitivity" `Switch`.
   - A `Slider` (-100..0 dB) over a `LevelMeter`, a custom component: a token-coloured bar that is
     `bg-online` above the threshold and `bg-muted` below.
   - The slider is disabled while auto is on, and its thumb then shows `thresholdDb` from the meter.
4. **Push-to-talk key** (PTT only):
   - A `Button` showing `pttKey.label`.
   - Clicking it enters "Press a key…": the next keydown is saved as `{ code, label }`, and Escape cancels.
5. **Noise suppression.** A `RadioGroup` with Off / Standard / Enhanced and their one-line descriptions.
   An inline note appears if Enhanced failed to load.
6. **Mic test.**
   - Outside a call, a "Let's check" button starts `createMicTest`, and the meter shows its level.
   - A "Hear yourself" `Switch` turns on the monitor.
   - The test stops when the section unmounts or the dialog closes.
   - During a call the meter reads `voice.micMeter()`, and the test button is hidden.

Every control saves immediately.

Accessible names are stable for e2e: "Input device", "Output device", "Voice activity", "Push to talk",
"Input sensitivity", "Push-to-talk key", "Noise suppression".

### `app/voice/ConnectionQuality.tsx`

- A `button` with a 3-bar signal icon:
  - good: 3 bars, `text-online`
  - ok: 2 bars, `text-idle`
  - poor: 1 bar, `text-destructive`
  - unknown: `text-muted-foreground`
- `aria-label`: "Connection quality: good, 42 ms ping".
- A `Tooltip` shows: "Ping 42 ms · Packet loss 0.3 % · Jitter 4 ms" and "Connection to the voice server".
- Hidden while reconnecting.

## Error handling

| Failure | Behaviour |
|---|---|
| RNNoise or AudioWorklet unavailable | Use Standard for the session, keep the saved setting, show a note in settings |
| Processor throws mid-call | `stopProcessor()`; the raw mic keeps sending |
| Device `NotFoundError` / `OverconstrainedError` | Fall back to default and show a message through `VoiceView.error` |
| Mic permission denied | Existing mic error; settings shows "Microphone blocked — allow it in your browser's site settings" |
| `getStats` fails or returns empty | Rating `unknown`, no error |

## Testing

### Unit tests (Vitest, Node, no DOM)

- **`gate.test.ts`:**
  - the threshold
  - the VAD 300 ms hold and PTT 200 ms release
  - PTT ignores the level
  - auto ignores a steady floor and adapts when the floor moves
- **`stats.test.ts`:**
  - `readQuality` on fake reports, both publishing and subscriber-only
  - `rate` thresholds, worst-wins and averaging
  - empty input gives `unknown`
- **`audio-prefs.test.ts`:** defaults, clamping, and rejecting corrupt values (mirrors `prefs.test.ts`).
- **`ptt.test.ts`** (uses a plain `EventTarget`):
  - a matching code goes down and up
  - repeats are ignored
  - typing in editable targets is ignored
  - a release is always seen
  - blur releases

### E2E (Playwright, Chromium fake media)

- **Settings:**
  - the Voice & audio section renders
  - switching input mode shows and hides sensitivity and the PTT key
  - the choices survive a reload
- **In a call:** the connection-quality button appears with a "Connection quality:" label.
- **Enhanced:** the call stays up, and the other side still sees the speaking indicator. If RNNoise
  filters the fake tone, assert on the publication's audio level instead.

### Manual only

RNNoise quality on real typing, real device switching, and the output device on Chrome and Firefox.

## Phases

Each phase ships on its own:

1. `audio-prefs`, the Voice & audio settings section with device pickers, device switching in calls, and
   output to soundboard and sounds.
2. `stats` and `ConnectionQuality`.
3. `gate`, `ptt`, `mic-processor` (without RNNoise), the level meter, sensitivity, push to talk, and the
   mic test.
4. RNNoise and the Enhanced noise suppression option.

## Out of scope

- Per-participant quality on tiles
- The connection debug panel
- Global push-to-talk hotkeys
- Server-side syncing of audio settings
- Krisp
