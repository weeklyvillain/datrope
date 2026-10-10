# Voice Audio Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a voice connection-quality indicator plus a "Voice & audio" settings section covering input/output
devices, voice activity or push to talk, input sensitivity, and noise suppression (Off / Standard / Enhanced
via RNNoise).

**Architecture:**
- Pure logic lives in small, unit-tested modules: `audio-prefs`, `gate`, `stats` and `ptt`.
- The mic audio graph is `MicChain` (source → optional RNNoise worklet → gate worklet → output track).
- `MicChain` is wrapped as a LiveKit `TrackProcessor` (`MicProcessor`) for calls, and as `createMicTest` for
  the settings page.
- `CallAudio` connects audio prefs, push to talk and device changes to one LiveKit room.
- `voice.ts` owns a `CallAudio` and a quality watcher per call.

**Tech Stack:** React 18, zustand 5, livekit-client 2.22.3, Web Audio (AudioWorklet),
`@sapphi-red/web-noise-suppressor` 0.4.1, shadcn/ui, Tailwind 4, Vitest 2 (Node), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-10-voice-audio-settings-design.md`

**Deviation from the spec (decided while planning):**
- The gate runs inside an AudioWorklet (`gate-worklet.ts`, which imports the pure `gate.ts`) instead of on a
  20 ms main-thread timer. Chrome throttles timers in background tabs to 1 Hz, which would cut speech while
  Datrope is not the visible tab.
- The device pickers use the repo's existing shadcn `NativeSelect` (already used by the other settings
  forms) instead of the Radix `Select`.
- The threshold slider sits directly under the level meter, which shows a threshold marker. It is not laid
  over the meter, because the slider's track would hide it.

## Global Constraints

- All work is in `clients/web`. There are no server or `clients/core` changes.
- Never commit. Stage each finished task with `git add` (CLAUDE.md, plus memory "Stage, don't commit").
- Write files via Bash heredoc or scratchpad + `cp`. The Write/Edit tools to project files may be blocked on
  this machine.
- Use colours only through tokens (`text-online`, `text-idle`, `text-destructive`, `text-muted-foreground`,
  `bg-online`, `bg-muted`, ...). Do not use `dark:` variants.
- Accessible names must be exactly: "Voice & audio", "Input device", "Output device", "Voice activity",
  "Push to talk", "Input sensitivity", "Push-to-talk key", "Noise suppression", and
  "Connection quality: <word>[, N ms ping]".
- localStorage key: `datrope.audioPrefs`. Defaults:
  - `inputDeviceId` / `outputDeviceId` `"default"`
  - `mode` `"vad"`
  - `vadAuto` `true`
  - `vadThresholdDb` `-50` (clamped to -100..0)
  - `pttKey` `{ code: "Backquote", label: "`" }`
  - `noise` `"standard"`
- Gate timings:
  - VAD hold 300 ms; PTT release 200 ms
  - auto threshold = noise floor + 15 dB, clamped to -70..-20
  - gain fade time constant 10 ms
- Quality ratings use the average of the last 3 samples, and the worst metric decides:

  | Rating | RTT | Loss | Jitter |
  |---|---|---|---|
  | good | < 100 ms | < 1 % | < 20 ms |
  | ok | < 250 ms | < 5 % | < 50 ms |
  | poor | otherwise | | |

  Poll every 2 s.
- Unit tests run in Node with no DOM. Never import `voice.ts`, `mic-processor.ts` or `call-audio.ts` from a
  test.

## Review Focus

1. **The PTT key is held when the window loses focus (Alt+Tab mid-sentence).** The mic must close, not
   stay open. Test: `ptt.test.ts` "blur releases".
2. **The PTT key is typed in the chat composer (backtick in a code span).** It must not transmit. Test:
   `ptt.test.ts` "ignores keys typed into text fields". Checkbox and radio inputs still count as
   shortcuts: "does not treat checkboxes as typing".
3. **The saved microphone is unplugged before joining.** The join must still work, on the default mic.
   Test: `audio-prefs.test.ts` "asks for the saved device as ideal, not exact".
4. **Corrupt or old localStorage** (wrong types, a missing `pttKey.code`, `null`). Fall back to the default
   field by field and never throw. Test: `audio-prefs.test.ts` "keeps good fields and drops bad ones".
5. **Silence and NaN levels from the mic** (`-Infinity` dB with a muted track). The gate must treat them as
   -100 dB and the auto floor must not become NaN. Test: `gate.test.ts` "treats silence and NaN as
   -100 dB".

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `clients/web/package.json` | modify | add `@sapphi-red/web-noise-suppressor` 0.4.1 |
| `src/voice/audio-prefs.ts` (+ `.test.ts`) | create | device-local audio settings store; `captureOptions`, `chainOptions` |
| `src/voice/gate.ts` (+ `.test.ts`) | create | pure gate decision (VAD/PTT, hold, auto floor) |
| `src/voice/stats.ts` (+ `.test.ts`) | create | `readSample`, `rate`, `watchQuality` |
| `src/voice/ptt.ts` (+ `.test.ts`) | create | push-to-talk key listener |
| `src/voice/gate-worklet.ts` | create | AudioWorkletProcessor: level + gate + gain fade, meter messages |
| `src/voice/rnnoise.ts` | create | lazy-load RNNoise worklet + wasm; `createRnnoise(ctx)` |
| `src/voice/mic-processor.ts` | create | `MicChain`, `MicProcessor`, `createMicTest` |
| `src/voice/output.ts` | create | `canPickOutput`, `routeToOutput` |
| `src/voice/call-audio.ts` | create | `CallAudio`: prefs → processor, PTT, device switching for one room |
| `src/voice/voice.ts` | modify | Room options from prefs, CallAudio, quality, `micMeter()` |
| `src/sounds.ts`, `src/voice/soundboard-audio.ts` | modify | `routeToOutput(el)` |
| `src/app/voice/ConnectionQuality.tsx` | create | signal bars + tooltip |
| `src/app/voice/VoicePanel.tsx` | modify | render `ConnectionQuality` while connected |
| `src/app/settings/VoiceSettings.tsx` | create | the settings section |
| `src/app/settings/settings-store.ts`, `UserSettingsDialog.tsx` | modify | add the `"voice"` section |
| `e2e/chat.spec.ts` | modify | settings + quality checks |

---

### Task 0: Workspace setup

- [ ] **Step 1:** From the worktree root, run `rtk pnpm install`. The worktree has no `node_modules`; this is
  an exFAT drive and `.npmrc` uses the hoisted linker.
- [ ] **Step 2:** From `clients/web`, run `rtk pnpm add @sapphi-red/web-noise-suppressor@0.4.1`. If pnpm fails
  on exFAT, add `"@sapphi-red/web-noise-suppressor": "0.4.1"` to `dependencies` by hand and re-run
  `rtk pnpm install` at the root.
- [ ] **Step 3:** Run the baseline: `rtk vitest run` and `rtk tsc -p tsconfig.json` in `clients/web`. Expected:
  both pass before any change.

### Task 1: Audio prefs store

**Files:** create `src/voice/audio-prefs.ts` and `src/voice/audio-prefs.test.ts`.

**Interfaces produced:**
- types: `AudioPrefs`, `InputMode`, `NoiseMode`, `PttKey`
- `audioPrefs` (zustand vanilla store), `audioDefaults`
- `useAudioPrefs(sel)`
- setters: `setInputDevice(id)`, `setOutputDevice(id)`, `setInputMode(m)`, `setVadAuto(on)`,
  `setVadThreshold(db)`, `setPttKey(k)`, `setNoise(n)`
- `captureOptions(p): AudioCaptureOptions`
- `chainOptions(p): ChainOptions`. `ChainOptions = GateSettings & { enhanced: boolean }`. It is defined
  here, with `GateSettings` imported from `gate.ts` as a type only.

- [ ] **Step 1: Write the failing test** (`audio-prefs.test.ts`)

```ts
import { beforeEach, describe, expect, it } from "vitest";

// Vitest runs in Node (no jsdom here): a tiny in-memory localStorage, set before the store loads.
const data = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => void data.set(k, String(v)),
  removeItem: (k: string) => void data.delete(k),
  clear: () => data.clear(),
  key: (i: number) => [...data.keys()][i] ?? null,
  get length() {
    return data.size;
  },
} as Storage;

const { audioDefaults, audioPrefs, captureOptions, chainOptions, loadAudioPrefs, setVadThreshold, setNoise } = await import("./audio-prefs");

describe("audio prefs", () => {
  beforeEach(() => {
    data.clear();
    audioPrefs.setState(audioDefaults, true);
  });

  it("starts with the defaults", () => {
    expect(loadAudioPrefs()).toEqual(audioDefaults);
    expect(audioDefaults.pttKey).toEqual({ code: "Backquote", label: "`" });
  });

  it("keeps good fields and drops bad ones", () => {
    data.set("datrope.audioPrefs", JSON.stringify({
      inputDeviceId: "mic-2", outputDeviceId: 7, mode: "ptt", vadAuto: "yes", vadThresholdDb: -250,
      pttKey: { label: "F" }, noise: "loud",
    }));
    expect(loadAudioPrefs()).toEqual({ ...audioDefaults, inputDeviceId: "mic-2", mode: "ptt", vadThresholdDb: -100 });
    data.set("datrope.audioPrefs", "null");
    expect(loadAudioPrefs()).toEqual(audioDefaults);
    data.set("datrope.audioPrefs", "{oops");
    expect(loadAudioPrefs()).toEqual(audioDefaults);
  });

  it("clamps the threshold and saves changes", () => {
    setVadThreshold(12.4);
    expect(audioPrefs.getState().vadThresholdDb).toBe(0);
    setNoise("enhanced");
    expect(JSON.parse(data.get("datrope.audioPrefs")!).noise).toBe("enhanced");
  });

  it("asks for the saved device as ideal, not exact", () => {
    expect(captureOptions({ ...audioDefaults, inputDeviceId: "mic-2" }).deviceId).toEqual({ ideal: "mic-2" });
    expect(captureOptions(audioDefaults).deviceId).toBeUndefined();
  });

  it("uses the browser's noise suppression only for Standard", () => {
    expect(captureOptions(audioDefaults)).toMatchObject({ noiseSuppression: true, echoCancellation: true, autoGainControl: true });
    expect(captureOptions({ ...audioDefaults, noise: "enhanced" }).noiseSuppression).toBe(false);
    expect(captureOptions({ ...audioDefaults, noise: "off" }).noiseSuppression).toBe(false);
  });

  it("maps prefs to processor options", () => {
    expect(chainOptions({ ...audioDefaults, mode: "ptt", vadAuto: false, vadThresholdDb: -42, noise: "enhanced" }))
      .toEqual({ mode: "ptt", auto: false, thresholdDb: -42, enhanced: true });
  });
});
```

- [ ] **Step 2:** Run `rtk vitest run src/voice/audio-prefs.test.ts`. Expected: FAIL (cannot resolve
  `./audio-prefs`).

- [ ] **Step 3: Implement** (`audio-prefs.ts`)

```ts
import type { AudioCaptureOptions } from "livekit-client";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { GateSettings } from "./gate";

export type InputMode = "vad" | "ptt";
export type NoiseMode = "off" | "standard" | "enhanced";
/** A push-to-talk key: `code` is matched (layout-independent), `label` is shown. */
export type PttKey = { code: string; label: string };

/** How this device captures and plays call audio. Stays on this device and is never sent. */
export type AudioPrefs = {
  inputDeviceId: string; // "default": the system's choice
  outputDeviceId: string;
  mode: InputMode;
  vadAuto: boolean;
  vadThresholdDb: number; // -100..0, used when vadAuto is off
  pttKey: PttKey;
  noise: NoiseMode;
};

/** What the mic processor runs with (see mic-processor.ts). */
export type ChainOptions = GateSettings & { enhanced: boolean };

const KEY = "datrope.audioPrefs";

export const audioDefaults: AudioPrefs = {
  inputDeviceId: "default", outputDeviceId: "default", mode: "vad", vadAuto: true, vadThresholdDb: -50,
  pttKey: { code: "Backquote", label: "`" }, noise: "standard",
};

const clampDb = (n: number) => Math.min(0, Math.max(-100, Math.round(n)));
const text = (x: unknown, fallback: string) => (typeof x === "string" && x !== "" ? x : fallback);
const oneOf = <T extends string>(x: unknown, values: readonly T[], fallback: T): T => (values.includes(x as T) ? (x as T) : fallback);

function pttKey(x: unknown): PttKey {
  const k = x as Partial<PttKey> | null;
  return k && typeof k === "object" && typeof k.code === "string" && k.code !== "" && typeof k.label === "string"
    ? { code: k.code, label: k.label }
    : audioDefaults.pttKey;
}

/** Reads the saved settings, keeping each valid field and defaulting the rest. */
export function loadAudioPrefs(): AudioPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return audioDefaults;
    const p = JSON.parse(raw) as Record<string, unknown> | null;
    if (!p || typeof p !== "object") return audioDefaults;
    return {
      inputDeviceId: text(p.inputDeviceId, audioDefaults.inputDeviceId),
      outputDeviceId: text(p.outputDeviceId, audioDefaults.outputDeviceId),
      mode: oneOf(p.mode, ["vad", "ptt"] as const, audioDefaults.mode),
      vadAuto: typeof p.vadAuto === "boolean" ? p.vadAuto : audioDefaults.vadAuto,
      vadThresholdDb: typeof p.vadThresholdDb === "number" && Number.isFinite(p.vadThresholdDb)
        ? clampDb(p.vadThresholdDb) : audioDefaults.vadThresholdDb,
      pttKey: pttKey(p.pttKey),
      noise: oneOf(p.noise, ["off", "standard", "enhanced"] as const, audioDefaults.noise),
    };
  } catch {
    return audioDefaults; // unavailable or unreadable: settings then last for this session
  }
}

export const audioPrefs = createStore<AudioPrefs>(() => loadAudioPrefs());

audioPrefs.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable (private window): kept in memory only.
  }
});

/** Subscribes a component to part of this device's audio settings. */
export function useAudioPrefs<T>(selector: (p: AudioPrefs) => T): T {
  return useStore(audioPrefs, selector);
}

export const setInputDevice = (inputDeviceId: string) => audioPrefs.setState({ inputDeviceId });
export const setOutputDevice = (outputDeviceId: string) => audioPrefs.setState({ outputDeviceId });
export const setInputMode = (mode: InputMode) => audioPrefs.setState({ mode });
export const setVadAuto = (vadAuto: boolean) => audioPrefs.setState({ vadAuto });
export const setVadThreshold = (db: number) => audioPrefs.setState({ vadThresholdDb: clampDb(db) });
export const setPttKey = (pttKey: PttKey) => audioPrefs.setState({ pttKey });
export const setNoise = (noise: NoiseMode) => audioPrefs.setState({ noise });

/**
 * Microphone constraints. The device is "ideal", so a missing one falls back to the default instead of failing;
 * the browser's own noise suppression is only on for Standard (Enhanced replaces it with RNNoise).
 */
export function captureOptions(p: AudioPrefs): AudioCaptureOptions {
  return {
    deviceId: p.inputDeviceId === "default" ? undefined : { ideal: p.inputDeviceId },
    noiseSuppression: p.noise === "standard",
    echoCancellation: true,
    autoGainControl: true,
  };
}

export function chainOptions(p: AudioPrefs): ChainOptions {
  return { mode: p.mode, auto: p.vadAuto, thresholdDb: p.vadThresholdDb, enhanced: p.noise === "enhanced" };
}
```

`audio-prefs.ts` imports `GateSettings` from `./gate` as a type only. Task 2 creates `gate.ts`, so do Task 2
Step 3 first, or create a stub with just
`export type GateSettings = { mode: "vad" | "ptt"; auto: boolean; thresholdDb: number };`.

- [ ] **Step 4:** Run `rtk vitest run src/voice/audio-prefs.test.ts`. Expected: PASS.
- [ ] **Step 5:** `rtk git add src/voice/audio-prefs.ts src/voice/audio-prefs.test.ts` (plus `gate.ts` if it was
  stubbed).

### Task 2: Gate logic

**Files:** create `src/voice/gate.ts` and `src/voice/gate.test.ts`.

**Interfaces produced:**
- `GateSettings = { mode: "vad" | "ptt"; auto: boolean; thresholdDb: number }`
- `GateInput = GateSettings & { levelDb: number; nowMs: number; pttDown: boolean }`
- `createGate(): { update(i: GateInput): boolean; thresholdDb(s: Pick<GateSettings, "auto" | "thresholdDb">): number }`
- constants `VAD_HOLD_MS = 300`, `PTT_RELEASE_MS = 200`

- [ ] **Step 1: Write the failing test** (`gate.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { createGate, PTT_RELEASE_MS, VAD_HOLD_MS, type GateSettings } from "./gate";

const manual: GateSettings = { mode: "vad", auto: false, thresholdDb: -50 };
const auto: GateSettings = { mode: "vad", auto: true, thresholdDb: -50 };
const ptt: GateSettings = { mode: "ptt", auto: false, thresholdDb: -50 };

/** Feeds `levelDb` every 20 ms from `fromMs` up to (not including) `toMs`; returns the last decision. */
function feed(gate: ReturnType<typeof createGate>, s: GateSettings, levelDb: number, fromMs: number, toMs: number, pttDown = false) {
  let open = false;
  for (let t = fromMs; t < toMs; t += 20) open = gate.update({ ...s, levelDb, nowMs: t, pttDown });
  return open;
}

describe("gate", () => {
  it("opens at the manual threshold", () => {
    const g = createGate();
    expect(g.update({ ...manual, levelDb: -50, nowMs: 0, pttDown: false })).toBe(true);
    const h = createGate();
    expect(h.update({ ...manual, levelDb: -51, nowMs: 0, pttDown: false })).toBe(false);
  });

  it("holds voice activity open for 300 ms after the last loud moment", () => {
    const g = createGate();
    g.update({ ...manual, levelDb: -30, nowMs: 0, pttDown: false });
    expect(g.update({ ...manual, levelDb: -90, nowMs: VAD_HOLD_MS - 20, pttDown: false })).toBe(true);
    expect(g.update({ ...manual, levelDb: -90, nowMs: VAD_HOLD_MS, pttDown: false })).toBe(false);
  });

  it("follows push to talk, ignoring the level, and closes 200 ms after release", () => {
    const g = createGate();
    expect(g.update({ ...ptt, levelDb: -100, nowMs: 0, pttDown: true })).toBe(true);
    expect(g.update({ ...ptt, levelDb: 0, nowMs: 100 + PTT_RELEASE_MS - 20, pttDown: false })).toBe(true);
    expect(g.update({ ...ptt, levelDb: 0, nowMs: 100 + PTT_RELEASE_MS + 100, pttDown: false })).toBe(false);
    expect(createGate().update({ ...ptt, levelDb: 0, nowMs: 0, pttDown: false })).toBe(false);
  });

  it("auto ignores a steady background and opens for speech", () => {
    const g = createGate();
    expect(feed(g, auto, -60, 0, 5000)).toBe(false); // a fan
    expect(g.thresholdDb(auto)).toBeCloseTo(-45, 0);
    expect(g.update({ ...auto, levelDb: -30, nowMs: 5000, pttDown: false })).toBe(true);
  });

  it("auto adapts when the background gets louder", () => {
    const g = createGate();
    feed(g, auto, -80, 0, 2000);
    expect(feed(g, auto, -50, 2000, 62_000)).toBe(false); // a minute of a louder fan: not speech any more
  });

  it("clamps the auto threshold", () => {
    const g = createGate();
    feed(g, auto, -100, 0, 1000);
    expect(g.thresholdDb(auto)).toBe(-70);
    feed(g, auto, -5, 1000, 200_000);
    expect(g.thresholdDb(auto)).toBe(-20);
    expect(g.thresholdDb(manual)).toBe(-50);
  });

  it("treats silence and NaN as -100 dB", () => {
    const g = createGate();
    expect(g.update({ ...auto, levelDb: -Infinity, nowMs: 0, pttDown: false })).toBe(false);
    expect(g.update({ ...auto, levelDb: Number.NaN, nowMs: 20, pttDown: false })).toBe(false);
    expect(g.thresholdDb(auto)).toBe(-70);
  });
});
```

- [ ] **Step 2:** Run `rtk vitest run src/voice/gate.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** (`gate.ts`)

```ts
/** Whether the mic is open: by loudness (voice activity) or while a key is held (push to talk). No Web Audio here. */

export type GateSettings = { mode: "vad" | "ptt"; auto: boolean; thresholdDb: number };
export type GateInput = GateSettings & { levelDb: number; nowMs: number; pttDown: boolean };

export const VAD_HOLD_MS = 300; // keeps word endings
export const PTT_RELEASE_MS = 200;
const SILENCE_DB = -100;
const AUTO_MARGIN_DB = 15;
const AUTO_MIN_DB = -70;
const AUTO_MAX_DB = -20;
const FALL_MS = 50; // the noise floor follows quiet quickly...
const RISE_MS = 10_000; // ...and loud slowly, so speech doesn't drag it up

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function createGate() {
  let floor: number | undefined;
  let lastMs: number | undefined;
  let activeMs = -Infinity;

  const thresholdDb = (s: Pick<GateSettings, "auto" | "thresholdDb">) =>
    s.auto ? clamp((floor ?? SILENCE_DB) + AUTO_MARGIN_DB, AUTO_MIN_DB, AUTO_MAX_DB) : s.thresholdDb;

  return {
    /** Takes the latest level (dBFS) and returns whether the mic is open. */
    update(i: GateInput): boolean {
      const level = Number.isFinite(i.levelDb) ? Math.max(SILENCE_DB, i.levelDb) : SILENCE_DB;
      const dt = lastMs === undefined ? 0 : Math.max(0, i.nowMs - lastMs);
      lastMs = i.nowMs;
      if (floor === undefined) floor = level;
      else floor += (level - floor) * (1 - Math.exp(-dt / (level < floor ? FALL_MS : RISE_MS)));
      const active = i.mode === "ptt" ? i.pttDown : level >= thresholdDb(i);
      if (active) activeMs = i.nowMs;
      return i.nowMs - activeMs < (i.mode === "ptt" ? PTT_RELEASE_MS : VAD_HOLD_MS);
    },
    /** The threshold in use: the manual one, or the noise floor plus a margin. */
    thresholdDb,
  };
}
```

- [ ] **Step 4:** Run `rtk vitest run src/voice/gate.test.ts`. Expected: PASS. If "clamps the auto threshold"
  fails on -20: 199 s at RISE_MS 10 s converges to within 1e-8, so check the clamp, not the test.
- [ ] **Step 5:** `rtk git add src/voice/gate.ts src/voice/gate.test.ts`

### Task 3: Push-to-talk listener

**Files:** create `src/voice/ptt.ts` and `src/voice/ptt.test.ts`.

**Interfaces produced:** `watchPtt(target: EventTarget, getCode: () => string, onChange: (down: boolean) => void): () => void`.

- [ ] **Step 1: Write the failing test** (`ptt.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { watchPtt } from "./ptt";

const key = (type: string, code: string, repeat = false) => Object.assign(new Event(type), { code, repeat });

function setup(target: EventTarget = new EventTarget()) {
  const changes: boolean[] = [];
  const stop = watchPtt(target, () => "Backquote", (d) => changes.push(d));
  return { target, changes, stop };
}

class FakeElement extends EventTarget {
  constructor(public tagName: string, public type = "", public isContentEditable = false) {
    super();
  }
}

describe("push to talk", () => {
  it("goes down and up with the key, once", () => {
    const { target, changes } = setup();
    target.dispatchEvent(key("keydown", "Backquote"));
    target.dispatchEvent(key("keydown", "Backquote", true));
    target.dispatchEvent(key("keydown", "KeyA"));
    target.dispatchEvent(key("keyup", "Backquote"));
    expect(changes).toEqual([true, false]);
  });

  it("ignores keys typed into text fields", () => {
    for (const el of [new FakeElement("INPUT", "text"), new FakeElement("TEXTAREA"), new FakeElement("DIV", "", true)]) {
      const { target, changes } = setup(el);
      target.dispatchEvent(key("keydown", "Backquote"));
      expect(changes).toEqual([]);
    }
  });

  it("does not treat checkboxes as typing", () => {
    const { target, changes } = setup(new FakeElement("INPUT", "checkbox"));
    target.dispatchEvent(key("keydown", "Backquote"));
    expect(changes).toEqual([true]);
  });

  it("blur releases", () => {
    const { target, changes } = setup();
    target.dispatchEvent(key("keydown", "Backquote"));
    target.dispatchEvent(new Event("blur"));
    target.dispatchEvent(key("keyup", "Backquote"));
    expect(changes).toEqual([true, false]);
  });

  it("stops listening", () => {
    const { target, changes, stop } = setup();
    stop();
    target.dispatchEvent(key("keydown", "Backquote"));
    expect(changes).toEqual([]);
  });
});
```

- [ ] **Step 2:** Run `rtk vitest run src/voice/ptt.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** (`ptt.ts`)

```ts
const NOT_TYPING = new Set(["checkbox", "radio", "range", "button", "submit", "reset", "color", "file"]);

/** Whether a key press is typing (into a text box or editable element) rather than a shortcut. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; type?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return el.tagName === "INPUT" && !NOT_TYPING.has(el.type ?? "");
}

/**
 * Reports when the push-to-talk key goes down and up. Typing it into a text field doesn't count; leaving the
 * window (or hiding the tab) lets go, so the mic can't stay open. Returns a function that stops listening.
 */
export function watchPtt(target: EventTarget, getCode: () => string, onChange: (down: boolean) => void): () => void {
  let down = false;
  const set = (d: boolean) => {
    if (d === down) return;
    down = d;
    onChange(d);
  };
  const keydown = (e: Event) => {
    const k = e as KeyboardEvent;
    if (k.code === getCode() && !k.repeat && !isTyping(k.target)) set(true);
  };
  const keyup = (e: Event) => {
    if ((e as KeyboardEvent).code === getCode()) set(false);
  };
  const release = () => set(false);
  const hidden = () => {
    if (document.hidden) set(false);
  };
  const doc = typeof document === "undefined" ? undefined : document;
  target.addEventListener("keydown", keydown);
  target.addEventListener("keyup", keyup);
  target.addEventListener("blur", release);
  doc?.addEventListener("visibilitychange", hidden);
  return () => {
    target.removeEventListener("keydown", keydown);
    target.removeEventListener("keyup", keyup);
    target.removeEventListener("blur", release);
    doc?.removeEventListener("visibilitychange", hidden);
  };
}
```

- [ ] **Step 4:** Run `rtk vitest run src/voice/ptt.test.ts`. Expected: PASS.
- [ ] **Step 5:** `rtk git add src/voice/ptt.ts src/voice/ptt.test.ts`

### Task 4: Connection stats

**Files:** create `src/voice/stats.ts` and `src/voice/stats.test.ts`.

**Interfaces produced:**
- `Rating = "good" | "ok" | "poor" | "unknown"`
- `Sample = { rttMs?: number; lossPct?: number; jitterMs?: number }`
- `Quality = Sample & { rating: Rating }`
- `Stat = { type: string; id: string; [k: string]: unknown }`
- `Counters = Map<string, { lost: number; received: number }>`
- `readSample(stats: Stat[], prev: Counters): { sample: Sample; counters: Counters }`
- `rate(samples: Sample[]): Quality`
- `watchQuality(room: Room, onQuality: (q: Quality) => void, everyMs?: number): () => void`
- `UNKNOWN: Quality`

- [ ] **Step 1: Write the failing test** (`stats.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { rate, readSample, type Stat } from "./stats";

const pair: Stat = { type: "candidate-pair", id: "cp", nominated: true, state: "succeeded", currentRoundTripTime: 0.042 };

describe("readSample", () => {
  it("reads RTT, loss and jitter while publishing", () => {
    const remote: Stat = { type: "remote-inbound-rtp", id: "r", kind: "audio", fractionLost: 0.02, jitter: 0.004, roundTripTime: 0.05 };
    const { sample } = readSample([pair, { type: "candidate-pair", id: "old", state: "failed", currentRoundTripTime: 9 }, remote], new Map());
    expect(sample.rttMs).toBeCloseTo(42);
    expect(sample.lossPct).toBeCloseTo(2);
    expect(sample.jitterMs).toBeCloseTo(4);
  });

  it("falls back to RTCP round trip without a candidate pair", () => {
    const { sample } = readSample([{ type: "remote-inbound-rtp", id: "r", kind: "audio", roundTripTime: 0.08 }], new Map());
    expect(sample.rttMs).toBeCloseTo(80);
  });

  it("computes loss from received audio between polls when not publishing", () => {
    const first = readSample([pair, { type: "inbound-rtp", id: "a", kind: "audio", packetsLost: 10, packetsReceived: 1000, jitter: 0.01 }], new Map());
    expect(first.sample.lossPct).toBeUndefined(); // no previous poll to compare with
    expect(first.sample.jitterMs).toBeCloseTo(10);
    const second = readSample([pair, { type: "inbound-rtp", id: "a", kind: "audio", packetsLost: 13, packetsReceived: 1097, jitter: 0.02 }], first.counters);
    expect(second.sample.lossPct).toBeCloseTo(3);
  });

  it("ignores video and returns nothing for an empty report", () => {
    expect(readSample([{ type: "inbound-rtp", id: "v", kind: "video", packetsLost: 5, packetsReceived: 5, jitter: 1 }], new Map()).sample).toEqual({});
    expect(readSample([], new Map()).sample).toEqual({});
  });
});

describe("rate", () => {
  it("is unknown without samples", () => {
    expect(rate([])).toEqual({ rating: "unknown" });
    expect(rate([{}, {}])).toEqual({ rating: "unknown" });
  });

  it("rates by the worst metric", () => {
    expect(rate([{ rttMs: 40, lossPct: 0, jitterMs: 5 }]).rating).toBe("good");
    expect(rate([{ rttMs: 40, lossPct: 2, jitterMs: 5 }]).rating).toBe("ok");
    expect(rate([{ rttMs: 300, lossPct: 0, jitterMs: 5 }]).rating).toBe("poor");
    expect(rate([{ rttMs: 99.9 }]).rating).toBe("good");
    expect(rate([{ rttMs: 100 }]).rating).toBe("ok");
    expect(rate([{ jitterMs: 50 }]).rating).toBe("poor");
  });

  it("averages the last three samples", () => {
    const q = rate([{ rttMs: 1000 }, { rttMs: 50 }, { rttMs: 60 }, { rttMs: 70 }]);
    expect(q.rttMs).toBeCloseTo(60);
    expect(q.rating).toBe("good");
    expect(rate([{ rttMs: 50 }, { rttMs: 50 }, { rttMs: 400 }]).rating).toBe("ok"); // one spike: average 166
  });
});
```

- [ ] **Step 2:** Run `rtk vitest run src/voice/stats.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** (`stats.ts`)

```ts
import { Track, type Room } from "livekit-client";

export type Rating = "good" | "ok" | "poor" | "unknown";
export type Sample = { rttMs?: number; lossPct?: number; jitterMs?: number };
export type Quality = Sample & { rating: Rating };
/** One entry of an RTCStatsReport. */
export type Stat = { type: string; id: string; [k: string]: unknown };
/** packetsLost / packetsReceived per inbound-rtp ID, from the previous poll. */
export type Counters = Map<string, { lost: number; received: number }>;

export const UNKNOWN: Quality = { rating: "unknown" };

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isAudio = (s: Stat) => s.kind === "audio" || s.mediaType === "audio";
const max = (xs: number[]) => (xs.length ? Math.max(...xs) : undefined);

/**
 * One measurement from WebRTC stats: round trip to the voice server, plus loss and jitter of my audio as the
 * server reports it (while I send) or of the audio I receive (otherwise; loss is counted since the last poll).
 */
export function readSample(stats: Stat[], prev: Counters): { sample: Sample; counters: Counters } {
  const sample: Sample = {};
  const counters: Counters = new Map();
  const pair = stats.find((s) => s.type === "candidate-pair" && (s.nominated === true || s.selected === true)
    && s.state === "succeeded" && num(s.currentRoundTripTime));
  if (pair) sample.rttMs = (pair.currentRoundTripTime as number) * 1000;

  const remote = stats.filter((s) => s.type === "remote-inbound-rtp" && isAudio(s));
  if (remote.length) {
    const lost = max(remote.map((s) => s.fractionLost).filter(num));
    const jitter = max(remote.map((s) => s.jitter).filter(num));
    const rtt = max(remote.map((s) => s.roundTripTime).filter(num));
    if (lost !== undefined) sample.lossPct = lost * 100;
    if (jitter !== undefined) sample.jitterMs = jitter * 1000;
    if (sample.rttMs === undefined && rtt !== undefined) sample.rttMs = rtt * 1000;
    return { sample, counters };
  }

  let lost = 0;
  let received = 0;
  const jitters: number[] = [];
  for (const s of stats) {
    if (s.type !== "inbound-rtp" || !isAudio(s) || !num(s.packetsLost) || !num(s.packetsReceived)) continue;
    counters.set(s.id, { lost: s.packetsLost, received: s.packetsReceived });
    if (num(s.jitter)) jitters.push(s.jitter);
    const before = prev.get(s.id);
    if (!before) continue;
    lost += Math.max(0, s.packetsLost - before.lost);
    received += Math.max(0, s.packetsReceived - before.received);
  }
  if (lost + received > 0) sample.lossPct = (lost / (lost + received)) * 100;
  const jitter = max(jitters);
  if (jitter !== undefined) sample.jitterMs = jitter * 1000;
  return { sample, counters };
}

// [good below, ok below]; anything higher is poor.
const LIMITS: Record<keyof Sample, [number, number]> = { rttMs: [100, 250], lossPct: [1, 5], jitterMs: [20, 50] };
const RATINGS = ["good", "ok", "poor"] as const;

/** Rates the connection from the last three samples (averaged, so one spike doesn't flip it); the worst metric wins. */
export function rate(samples: Sample[]): Quality {
  const recent = samples.slice(-3);
  const q: Quality = { rating: "unknown" };
  let worst = -1;
  for (const key of Object.keys(LIMITS) as (keyof Sample)[]) {
    const values = recent.map((s) => s[key]).filter(num);
    if (!values.length) continue;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    q[key] = avg;
    const [good, ok] = LIMITS[key];
    worst = Math.max(worst, avg < good ? 0 : avg < ok ? 1 : 2);
  }
  if (worst >= 0) q.rating = RATINGS[worst];
  return q;
}

/** Measures my connection to the voice server every `everyMs` while in a call. Returns a function that stops. */
export function watchQuality(room: Room, onQuality: (q: Quality) => void, everyMs = 2000): () => void {
  let stopped = false;
  let prev: Counters = new Map();
  const history: Sample[] = [];
  const poll = async () => {
    const tracks: Track[] = [];
    const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (mic) tracks.push(mic);
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.audioTrackPublications.values()) if (pub.track) tracks.push(pub.track);
    }
    const reports = await Promise.all(tracks.map((t) => t.getRTCStatsReport().catch(() => undefined)));
    if (stopped) return;
    const stats = reports.flatMap((r) => (r ? ([...r.values()] as Stat[]) : []));
    const { sample, counters } = readSample(stats, prev);
    prev = counters;
    history.push(sample);
    if (history.length > 3) history.shift();
    onQuality(rate(history));
  };
  const tick = () => void poll().catch(() => undefined); // stats are best effort: never an error in the UI
  const timer = setInterval(tick, everyMs);
  tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
```

- [ ] **Step 4:** Run `rtk vitest run src/voice/stats.test.ts`. Expected: PASS.
- [ ] **Step 5:** `rtk git add src/voice/stats.ts src/voice/stats.test.ts`

### Task 5: Mic processing chain (gate worklet, RNNoise, MicChain, MicProcessor, mic test)

**Files:** create `src/voice/gate-worklet.ts`, `src/voice/rnnoise.ts`, `src/voice/mic-processor.ts` and
`src/voice/output.ts`.

**Interfaces:**
- **Consumes:**
  - `createGate`, `GateSettings` (Task 2)
  - `ChainOptions`, `audioPrefs` (Task 1)
- **Produces:**
  - `GateMessage = Partial<GateSettings> & { pttDown?: boolean }`
  - `Meter = { db: number; open: boolean; thresholdDb: number }`
  - `class MicChain`:
    - `static create(input: MediaStreamTrack, opts: ChainOptions): Promise<MicChain>`
    - `output: MediaStreamTrack`, `enhancedFailed: boolean`
    - `setInput(track)`, `setOptions(opts)`, `setPtt(down)`, `meter(): Meter`, `close()`
  - `class MicProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>`:
    - constructor `(opts: ChainOptions)`
    - `setOptions(opts)`, `setPtt(down)`, `meter(): Meter | undefined`, `enhancedFailed: boolean`
  - `createMicTest(constraints: MediaTrackConstraints, opts: ChainOptions, outputDeviceId: string): Promise<MicTest>`,
    where `MicTest = { chain: MicChain; setMonitor(on: boolean): void; stop(): void }`
  - `canPickOutput(): boolean`
  - `routeToOutput(el: HTMLMediaElement, deviceId?: string): void`
  - `createRnnoise(ctx: AudioContext): Promise<AudioWorkletNode & { destroy(): void }>`

There are no unit tests: this is Web Audio glue, and the logic it uses is tested in Task 2. It is verified by
typecheck plus the browser checks in Task 9.

- [ ] **Step 1: `gate-worklet.ts`**

```ts
// AudioWorklet processor for the mic: measures the level every 20 ms, asks the gate (gate.ts) whether the mic is
// open and fades the sound in or out. It runs on the audio thread, so background-tab timer throttling can't cut
// speech. Bundled on its own (imported with ?worker&url), so it must not import app code beyond gate.ts.
import { createGate, type GateSettings } from "./gate";

declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, ctor: new (options: { processorOptions?: GateMessage }) => object): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

export type GateMessage = Partial<GateSettings> & { pttDown?: boolean };
export type Meter = { db: number; open: boolean; thresholdDb: number };

const WINDOW_S = 0.02;
const FADE_S = 0.01;
const METER_S = 0.05;

class GateProcessor extends AudioWorkletProcessor {
  private gate = createGate();
  private settings: GateSettings = { mode: "vad", auto: true, thresholdDb: -50 };
  private pttDown = false;
  private sum = 0;
  private count = 0;
  private open = false;
  private gain = 0;
  private db = -100;
  private meterAt = 0;
  private readonly windowLength = Math.round(sampleRate * WINDOW_S);
  private readonly fade = 1 - Math.exp(-1 / (sampleRate * FADE_S));

  constructor(options: { processorOptions?: GateMessage }) {
    super();
    this.apply(options.processorOptions ?? {});
    this.port.onmessage = (e: MessageEvent<GateMessage>) => this.apply(e.data);
  }

  private apply({ pttDown, ...settings }: GateMessage) {
    if (pttDown !== undefined) this.pttDown = pttDown;
    this.settings = { ...this.settings, ...settings };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0];
    const n = output[0]?.length ?? 0;
    for (let i = 0; i < n; i++) {
      const x = input ? input[i] : 0;
      this.sum += x * x;
      if (++this.count >= this.windowLength) {
        this.db = Math.max(-100, 10 * Math.log10(this.sum / this.count));
        this.sum = 0;
        this.count = 0;
        this.open = this.gate.update({ ...this.settings, levelDb: this.db, nowMs: currentTime * 1000, pttDown: this.pttDown });
      }
      this.gain += ((this.open ? 1 : 0) - this.gain) * this.fade;
      for (const channel of output) channel[i] = x * this.gain;
    }
    if (currentTime - this.meterAt >= METER_S) {
      this.meterAt = currentTime;
      this.port.postMessage({ db: this.db, open: this.open, thresholdDb: this.gate.thresholdDb(this.settings) } satisfies Meter);
    }
    return true;
  }
}

registerProcessor("datrope-gate", GateProcessor);
```

- [ ] **Step 2: `rnnoise.ts`**

```ts
// RNNoise (Enhanced noise suppression), loaded on first use: ~150 KB of worklet and WebAssembly.
let wasm: Promise<ArrayBuffer> | undefined;
const ready = new WeakSet<BaseAudioContext>();

/** An RNNoise node for a 48 kHz context. Rejects when AudioWorklet or WebAssembly isn't available. */
export async function createRnnoise(ctx: AudioContext): Promise<AudioWorkletNode & { destroy(): void }> {
  const [lib, worklet, url, simdUrl] = await Promise.all([
    import("@sapphi-red/web-noise-suppressor"),
    import("@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url"),
    import("@sapphi-red/web-noise-suppressor/rnnoise.wasm?url"),
    import("@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url"),
  ]);
  wasm ??= lib.loadRnnoise({ url: url.default, simdUrl: simdUrl.default });
  const binary = await wasm.catch((e: unknown) => {
    wasm = undefined; // try again next time
    throw e;
  });
  if (!ready.has(ctx)) {
    await ctx.audioWorklet.addModule(worklet.default);
    ready.add(ctx);
  }
  return new lib.RnnoiseWorkletNode(ctx, { wasmBinary: binary, maxChannels: 1 });
}
```

- [ ] **Step 3: `output.ts`**

```ts
import { audioPrefs } from "./audio-prefs";

/** Whether call audio can go to a chosen speaker: it plays through Web Audio, whose setSinkId Firefox lacks. */
export const canPickOutput = () => typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;

/** Plays an element (soundboard, UI sounds, mic test) through the chosen output device, when the browser can. */
export function routeToOutput(el: HTMLMediaElement, deviceId = audioPrefs.getState().outputDeviceId) {
  const sink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (deviceId === "default" || !sink.setSinkId) return;
  sink.setSinkId(deviceId).catch(() => undefined); // device gone: keep the default
}
```

- [ ] **Step 4: `mic-processor.ts`**

```ts
import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import type { ChainOptions } from "./audio-prefs";
import type { GateMessage, Meter } from "./gate-worklet";
import gateUrl from "./gate-worklet?worker&url";
import { routeToOutput } from "./output";
import { createRnnoise } from "./rnnoise";

export type { Meter };

const QUIET: Meter = { db: -100, open: false, thresholdDb: -50 };

const settings = ({ enhanced: _, ...s }: ChainOptions): GateMessage => s;

/** The mic's audio graph: source → [RNNoise] → gate → output track. Used for calls (MicProcessor) and the mic test. */
export class MicChain {
  readonly output: MediaStreamTrack;
  enhancedFailed = false;
  private source?: MediaStreamAudioSourceNode;
  private rnnoise?: AudioWorkletNode & { destroy(): void };
  private last = QUIET;
  private wiring = 0;

  private constructor(private ctx: AudioContext, private gate: AudioWorkletNode, private opts: ChainOptions) {
    const dest = ctx.createMediaStreamDestination();
    gate.connect(dest);
    this.output = dest.stream.getAudioTracks()[0];
    gate.port.onmessage = (e: MessageEvent<Meter>) => {
      this.last = e.data;
    };
  }

  static async create(input: MediaStreamTrack, opts: ChainOptions): Promise<MicChain> {
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" }); // RNNoise needs 48 kHz
    try {
      await ctx.audioWorklet.addModule(gateUrl);
      const gate = new AudioWorkletNode(ctx, "datrope-gate", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: settings(opts),
      });
      const chain = new MicChain(ctx, gate, opts);
      await chain.setInput(input);
      if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
      return chain;
    } catch (e) {
      void ctx.close();
      throw e;
    }
  }

  /** Switches to another mic track (LiveKit restarts the track when the device changes). */
  async setInput(track: MediaStreamTrack) {
    this.source?.disconnect();
    this.source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    await this.wire();
  }

  setOptions(opts: ChainOptions) {
    const rewire = opts.enhanced !== this.opts.enhanced;
    this.opts = opts;
    this.gate.port.postMessage(settings(opts));
    if (rewire) void this.wire();
  }

  setPtt(down: boolean) {
    this.gate.port.postMessage({ pttDown: down } satisfies GateMessage);
  }

  /** The latest level and gate state, updated about 20 times a second. */
  meter(): Meter {
    return this.last;
  }

  /** Connects source → [RNNoise] → gate; without RNNoise when it is off or fails to load. */
  private async wire() {
    const id = ++this.wiring;
    const node = this.opts.enhanced ? await createRnnoise(this.ctx).catch(() => undefined) : undefined;
    if (id !== this.wiring) {
      node?.destroy(); // superseded by a newer call
      return;
    }
    this.enhancedFailed = this.opts.enhanced && !node;
    this.source?.disconnect();
    this.rnnoise?.disconnect();
    this.rnnoise?.destroy();
    this.rnnoise = node;
    if (!this.source) return;
    if (node) {
      this.source.connect(node);
      node.connect(this.gate);
    } else {
      this.source.connect(this.gate);
    }
  }

  async close() {
    this.wiring++;
    this.source?.disconnect();
    this.rnnoise?.destroy();
    this.output.stop();
    await this.ctx.close().catch(() => undefined);
  }
}

/** Runs the call's mic through a MicChain; LiveKit calls restart when the device changes. */
export class MicProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = "datrope-mic";
  processedTrack?: MediaStreamTrack;
  private chain?: MicChain;
  private ptt = false;

  constructor(private opts: ChainOptions) {}

  async init(o: AudioProcessorOptions) {
    const chain = await MicChain.create(o.track, this.opts);
    chain.setPtt(this.ptt);
    this.chain = chain;
    this.processedTrack = chain.output;
  }

  async restart(o: AudioProcessorOptions) {
    if (!this.chain) return this.init(o);
    await this.chain.setInput(o.track);
  }

  async destroy() {
    const chain = this.chain;
    this.chain = undefined;
    this.processedTrack = undefined;
    await chain?.close();
  }

  setOptions(opts: ChainOptions) {
    this.opts = opts;
    this.chain?.setOptions(opts);
  }

  setPtt(down: boolean) {
    this.ptt = down;
    this.chain?.setPtt(down);
  }

  meter(): Meter | undefined {
    return this.chain?.meter();
  }

  get enhancedFailed(): boolean {
    return this.chain?.enhancedFailed ?? false;
  }
}

export type MicTest = { chain: MicChain; setMonitor(on: boolean): void; stop(): void };

/** A mic outside a call, for the settings page: the same processing, optionally played back ("Hear yourself"). */
export async function createMicTest(constraints: MediaTrackConstraints, opts: ChainOptions, outputDeviceId: string): Promise<MicTest> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  const track = stream.getAudioTracks()[0];
  let chain: MicChain;
  try {
    chain = await MicChain.create(track, opts);
  } catch (e) {
    track.stop();
    throw e;
  }
  const el = new Audio();
  el.srcObject = new MediaStream([chain.output]);
  el.muted = true;
  routeToOutput(el, outputDeviceId);
  void el.play().catch(() => undefined);
  return {
    chain,
    setMonitor: (on) => {
      el.muted = !on;
    },
    stop: () => {
      el.pause();
      el.srcObject = null;
      track.stop();
      void chain.close();
    },
  };
}
```

- [ ] **Step 5:** Run `rtk tsc -p tsconfig.json` in `clients/web`. Expected: no errors.
  - If `?worker&url` has no type, check `vite/client` declares `*?worker&url`. If not, add
    `declare module "*?worker&url" { const src: string; export default src; }` to `src/vite-env.d.ts`.
  - The same applies to the package's `rnnoiseWorklet.js?url`, which is covered by `*?url` in `vite/client`.
- [ ] **Step 6:** Run `rtk vitest run`. Expected: all pass. No test imports these files.
- [ ] **Step 7:** `rtk git add src/voice/gate-worklet.ts src/voice/rnnoise.ts src/voice/mic-processor.ts src/voice/output.ts package.json ../../pnpm-lock.yaml`

### Task 6: Call integration (CallAudio, voice.ts, sounds)

**Files:**
- create `src/voice/call-audio.ts`
- modify `src/voice/voice.ts`, `src/sounds.ts` and `src/voice/soundboard-audio.ts`

**Interfaces:**
- **Consumes:** everything from Tasks 1–5.
- **Produces:**
  - `VoiceView.quality: Quality`
  - `voice.micMeter(): (Meter & { enhancedFailed: boolean }) | undefined`

- [ ] **Step 1: `call-audio.ts`**

```ts
import { Track, type LocalAudioTrack, type Room } from "livekit-client";
import { audioPrefs, captureOptions, chainOptions, type AudioPrefs } from "./audio-prefs";
import { MicProcessor } from "./mic-processor";
import { canPickOutput } from "./output";
import { watchPtt } from "./ptt";

/** Applies this device's audio settings to one call: the mic processor, push to talk, and device or setting changes. */
export class CallAudio {
  readonly processor = new MicProcessor(chainOptions(audioPrefs.getState()));
  private stops: (() => void)[] = [];

  constructor(private room: Room, private onError: (message: string) => void) {
    this.stops.push(audioPrefs.subscribe((p, old) => void this.changed(p, old)));
    this.stops.push(watchPtt(window, () => audioPrefs.getState().pttKey.code, (down) => this.processor.setPtt(down)));
  }

  private mic(): LocalAudioTrack | undefined {
    return this.room.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack as LocalAudioTrack | undefined;
  }

  /** Runs the mic through the processor; call after turning it on. If that fails, the raw mic is sent. */
  async attach() {
    const track = this.mic();
    if (!track || track.getProcessor() === this.processor) return;
    try {
      await track.setProcessor(this.processor);
    } catch {
      await track.stopProcessor().catch(() => undefined);
    }
  }

  private async changed(p: AudioPrefs, old: AudioPrefs) {
    this.room.options.audioCaptureDefaults = captureOptions(p); // for the next time the mic starts
    this.processor.setOptions(chainOptions(p));
    if (p.outputDeviceId !== old.outputDeviceId && canPickOutput()) {
      await this.room.switchActiveDevice("audiooutput", p.outputDeviceId).catch(() => undefined);
    }
    if (p.inputDeviceId !== old.inputDeviceId) await this.switchInput(p.inputDeviceId);
    else if ((p.noise === "standard") !== (old.noise === "standard")) {
      // The browser's noise suppression is fixed when capture starts.
      await this.mic()?.restartTrack(captureOptions(p)).catch(() => undefined);
    }
  }

  private async switchInput(id: string) {
    try {
      await this.room.switchActiveDevice("audioinput", id);
    } catch {
      if (id === "default") return;
      this.onError("Couldn't use that microphone, so the default one is used.");
      await this.room.switchActiveDevice("audioinput", "default").catch(() => undefined);
    }
  }

  stop() {
    for (const stop of this.stops) stop();
    this.stops = [];
  }
}
```

- [ ] **Step 2: `voice.ts` edits.** Apply exactly these changes.
  1. Imports. Add:

     ```ts
     import { audioPrefs, captureOptions } from "./audio-prefs";
     import { CallAudio } from "./call-audio";
     import { canPickOutput } from "./output";
     import { UNKNOWN, watchQuality, type Quality } from "./stats";
     ```
  2. `VoiceView`. Add `quality: Quality; // my connection to the voice server`. In `idle`, add
     `quality: UNKNOWN`.
  3. Fields:

     ```ts
     private callAudio?: CallAudio; // this device's audio settings applied to the call
     private unwatchQuality?: () => void;
     ```
  4. In `join`, replace the `new Room(...)` line with:

     ```ts
     const prefs = audioPrefs.getState();
     const room = new Room({
       adaptiveStream: true, dynacast: true, webAudioMix: true, publishDefaults: { simulcast: true },
       audioCaptureDefaults: captureOptions(prefs),
       audioOutput: canPickOutput() ? { deviceId: prefs.outputDeviceId } : undefined,
     });
     ```
     After `this.room = room;`, add:
     `this.callAudio = new CallAudio(room, (error) => { if (this.room === room) this.set({ error }); });`
  5. After `this.set({ status: "connected", ... });` in `join`, add:
     `this.unwatchQuality = watchQuality(room, (quality) => { if (this.room === room) this.set({ quality }); });`
  6. In `disconnect()`, after the `unwatchPrefs` lines, add:

     ```ts
     this.unwatchQuality?.();
     this.unwatchQuality = undefined;
     this.callAudio?.stop();
     this.callAudio = undefined;
     ```
  7. In `applyMic`, replace `await room.localParticipant.setMicrophoneEnabled(allowed && !muted);` with:

     ```ts
     await room.localParticipant.setMicrophoneEnabled(allowed && !muted);
     if (allowed && !muted && this.room === room) await this.callAudio?.attach();
     ```
  8. Add this method next to `startAudio()`:

     ```ts
     /** My mic's level and gate state while in a call, for the settings meter. */
     micMeter() {
       const p = this.callAudio?.processor;
       const m = p?.meter();
       return m && p ? { ...m, enhancedFailed: p.enhancedFailed } : undefined;
     }
     ```
- [ ] **Step 3: sounds.** In `sounds.ts`, add `import { routeToOutput } from "./voice/output";` and call
  `routeToOutput(audio);` before `audio.play()`. In `soundboard-audio.ts`, add
  `import { routeToOutput } from "./output";` and call `routeToOutput(el);` before `el.play()`.
- [ ] **Step 4:** Run `rtk tsc -p tsconfig.json`. Expected: no errors.
  - If `room.options` is readonly-typed, use `Object.assign(this.room.options, { audioCaptureDefaults: captureOptions(p) })`.
  - If `audioOutput` is not in `RoomOptions`, look it up in `livekit-client/dist/src/options.d.ts` (line 47).
- [ ] **Step 5:** Run `rtk vitest run`. Expected: all pass. `soundboard-audio.test.ts` now loads `output.ts` and
  `audio-prefs.ts`; their localStorage access is wrapped in try/catch.
- [ ] **Step 6:** `rtk git add src/voice/call-audio.ts src/voice/voice.ts src/sounds.ts src/voice/soundboard-audio.ts`

### Task 7: Connection quality indicator

**Files:** create `src/app/voice/ConnectionQuality.tsx`; modify `src/app/voice/VoicePanel.tsx`.

- [ ] **Step 1: `ConnectionQuality.tsx`**

```tsx
import { SignalHigh, SignalLow, SignalMedium, SignalZero, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Rating } from "../../voice/stats";
import { useVoice } from "../../voice/voice";

const LOOK: Record<Rating, { icon: LucideIcon; color: string; word: string }> = {
  good: { icon: SignalHigh, color: "text-online", word: "good" },
  ok: { icon: SignalMedium, color: "text-idle", word: "okay" },
  poor: { icon: SignalLow, color: "text-destructive", word: "poor" },
  unknown: { icon: SignalZero, color: "text-muted-foreground", word: "measuring" },
};

/** Signal bars for my connection to the voice server; the tooltip has the numbers. */
export function ConnectionQuality() {
  const q = useVoice((v) => v.quality);
  const look = LOOK[q.rating];
  const Icon = look.icon;
  const ping = q.rttMs === undefined ? "" : `, ${Math.round(q.rttMs)} ms ping`;
  const details = [
    q.rttMs !== undefined && `Ping ${Math.round(q.rttMs)} ms`,
    q.lossPct !== undefined && `Packet loss ${q.lossPct.toFixed(1)} %`,
    q.jitterMs !== undefined && `Jitter ${Math.round(q.jitterMs)} ms`,
  ].filter(Boolean).join(" · ");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Connection quality: ${look.word}${ping}`} className={cn(look.color, `hover:${look.color}`)}>
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{details || "Measuring…"}</p>
        <p className="text-xs opacity-80">Connection to the voice server</p>
      </TooltipContent>
    </Tooltip>
  );
}
```

  Note: Tailwind cannot see a dynamic `hover:${...}` class. Instead, put the full class in `LOOK`, e.g.
  `color: "text-online hover:text-online"`, and use `className={look.color}`.

- [ ] **Step 2: `VoicePanel.tsx`.** Add `import { ConnectionQuality } from "./ConnectionQuality";`. In the row
  with the status text, insert `{v.status === "connected" && <ConnectionQuality />}` just before the
  Disconnect `<Tooltip>`.
- [ ] **Step 3:** Run `rtk tsc -p tsconfig.json`. Expected: no errors.
- [ ] **Step 4:** `rtk git add src/app/voice/ConnectionQuality.tsx src/app/voice/VoicePanel.tsx`

### Task 8: Voice & audio settings section

**Files:**
- create `src/app/settings/VoiceSettings.tsx`
- modify `src/app/settings/settings-store.ts` and `src/app/settings/UserSettingsDialog.tsx`

- [ ] **Step 1: settings store.** In `settings-store.ts`, change the `SettingsSection` type to
  `"profile" | "sessions" | "notifications" | "voice" | "appearance"`.
- [ ] **Step 2: dialog.**
  - In `UserSettingsDialog.tsx`, import `Headphones` from lucide-react and `VoiceSettings` from
    `./VoiceSettings`.
  - Insert this into `SECTIONS` after notifications:
    `{ id: "voice", label: "Voice & audio", group: "App", icon: Headphones, body: () => <VoiceSettings /> },`
- [ ] **Step 3: `VoiceSettings.tsx`**

```tsx
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  captureOptions, chainOptions, setInputDevice, setInputMode, setNoise, setOutputDevice, setPttKey, setVadAuto,
  setVadThreshold, useAudioPrefs, type InputMode, type NoiseMode, type PttKey,
} from "../../voice/audio-prefs";
import { createMicTest, type Meter, type MicTest } from "../../voice/mic-processor";
import { canPickOutput } from "../../voice/output";
import { useVoice, voice } from "../../voice/voice";

type Reading = Meter & { enhancedFailed: boolean };

const modes: { value: InputMode; title: string; hint: string }[] = [
  { value: "vad", title: "Voice activity", hint: "Your mic opens when you speak louder than the sensitivity." },
  { value: "ptt", title: "Push to talk", hint: "Hold a key to talk. Works while Datrope is the active tab." },
];
const noises: { value: NoiseMode; title: string; hint: string }[] = [
  { value: "off", title: "Off", hint: "Send your mic as it is." },
  { value: "standard", title: "Standard", hint: "Built into your browser. Filters steady background noise." },
  { value: "enhanced", title: "Enhanced", hint: "Removes keyboard typing and other noise. Uses a bit more CPU." },
];

/** The browser's audio devices, refreshed when one is plugged in or out. Labels are empty until the mic is allowed. */
function useDevices() {
  const [list, setList] = useState<MediaDeviceInfo[]>([]);
  const refresh = useCallback(() => {
    navigator.mediaDevices?.enumerateDevices().then(setList, () => setList([]));
  }, []);
  useEffect(() => {
    refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", refresh);
  }, [refresh]);
  const real = (kind: MediaDeviceKind) => list.filter((d) => d.kind === kind && d.deviceId !== "default" && d.deviceId !== "communications");
  return { inputs: real("audioinput"), outputs: real("audiooutput"), labelled: list.some((d) => d.label !== ""), refresh };
}

/** Reads `source` every animation frame while it is set. */
function useReading(source: (() => Reading | undefined) | undefined): Reading | undefined {
  const [reading, setReading] = useState<Reading>();
  useEffect(() => {
    if (!source) return setReading(undefined);
    let frame = 0;
    const tick = () => {
      setReading(source());
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [source]);
  return reading;
}

const pct = (db: number) => `${Math.min(100, Math.max(0, db + 100))}%`;

function LevelMeter({ reading, thresholdDb }: { reading?: Reading; thresholdDb?: number }) {
  const db = reading?.db ?? -100;
  return (
    <div className="relative h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-label="Microphone level"
      aria-valuemin={-100} aria-valuemax={0} aria-valuenow={Math.round(db)}>
      <div className={cn("h-full transition-[width] duration-75", reading?.open ? "bg-online" : "bg-muted-foreground/40")} style={{ width: pct(db) }} />
      {thresholdDb !== undefined && <div className="absolute inset-y-0 w-0.5 bg-foreground" style={{ left: pct(thresholdDb) }} aria-hidden />}
    </div>
  );
}

const keyLabel = (e: KeyboardEvent) => (e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key);

/** A button that records the next key press as the push-to-talk key; Escape cancels. */
function KeyCapture({ value, onChange }: { value: PttKey; onChange: (k: PttKey) => void }) {
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation(); // capture phase on window: Escape must not close the dialog
      if (e.code !== "Escape") onChange({ code: e.code, label: keyLabel(e) });
      setListening(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, onChange]);
  return (
    <Button variant="outline" aria-label={`Push-to-talk key, ${value.label}`} onClick={() => setListening(true)} className="min-w-28">
      {listening ? "Press a key…" : value.label}
    </Button>
  );
}

function Choices<T extends string>({ name, label, value, options, onChange }: {
  name: string; label: string; value: T; options: { value: T; title: string; hint: string }[]; onChange: (v: T) => void;
}) {
  return (
    <RadioGroup aria-label={label} value={value} onValueChange={(v) => onChange(v as T)} className="gap-2">
      {options.map((o) => (
        <Label key={o.value} htmlFor={`${name}-${o.value}`}
          className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-3", value === o.value && "border-primary bg-primary/8")}>
          <RadioGroupItem id={`${name}-${o.value}`} value={o.value} className="mt-0.5" aria-labelledby={`${name}-${o.value}-title`} aria-describedby={`${name}-${o.value}-hint`} />
          <div className="grid gap-0">
            <span id={`${name}-${o.value}-title`} className="font-medium">{o.title}</span>
            <span id={`${name}-${o.value}-hint`} className="text-sm font-normal text-muted-foreground">{o.hint}</span>
          </div>
        </Label>
      ))}
    </RadioGroup>
  );
}

export function VoiceSettings() {
  const p = useAudioPrefs((s) => s);
  const inCall = useVoice((v) => v.status === "connected");
  const devices = useDevices();
  const [blocked, setBlocked] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<MicTest>();
  const [testError, setTestError] = useState<string>();
  const [monitor, setMonitor] = useState(false);
  const standard = p.noise === "standard";

  async function allow() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const t of s.getTracks()) t.stop();
      setBlocked(false);
      devices.refresh();
    } catch {
      setBlocked(true);
    }
  }

  // The mic test: restarted when the device or the browser's noise suppression changes, stopped on leaving.
  useEffect(() => {
    if (!testing || inCall) return;
    let current: MicTest | undefined;
    let cancelled = false;
    setTestError(undefined);
    createMicTest(captureOptions(p) as MediaTrackConstraints, chainOptions(p), p.outputDeviceId).then((t) => {
      if (cancelled) return t.stop();
      current = t;
      setTest(t);
    }, () => {
      if (cancelled) return;
      setTesting(false);
      setTestError("Couldn't start your microphone.");
    });
    return () => {
      cancelled = true;
      current?.stop();
      setTest(undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- options below are applied without a restart
  }, [testing, inCall, p.inputDeviceId, p.outputDeviceId, standard]);
  useEffect(() => test?.chain.setOptions(chainOptions(p)), [test, p]);
  useEffect(() => test?.setMonitor(monitor), [test, monitor]);

  const source = useCallback((): Reading | undefined => {
    if (inCall) return voice.micMeter();
    return test ? { ...test.chain.meter(), enhancedFailed: test.chain.enhancedFailed } : undefined;
  }, [inCall, test]);
  const reading = useReading(inCall || test ? source : undefined);
  const has = (list: MediaDeviceInfo[], id: string) => list.some((d) => d.deviceId === id);

  return (
    <>
      <Card role="region" aria-label="Devices" className="gap-3 p-4">
        <h3>Devices</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="input-device">Input device</Label>
            <NativeSelect id="input-device" className="w-full" value={has(devices.inputs, p.inputDeviceId) ? p.inputDeviceId : "default"}
              onChange={(e) => setInputDevice(e.target.value)}>
              <NativeSelectOption value="default">Default</NativeSelectOption>
              {devices.inputs.map((d, i) => <NativeSelectOption key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</NativeSelectOption>)}
            </NativeSelect>
          </div>
          {canPickOutput() && (
            <div className="grid gap-1.5">
              <Label htmlFor="output-device">Output device</Label>
              <NativeSelect id="output-device" className="w-full" value={has(devices.outputs, p.outputDeviceId) ? p.outputDeviceId : "default"}
                onChange={(e) => setOutputDevice(e.target.value)}>
                <NativeSelectOption value="default">Default</NativeSelectOption>
                {devices.outputs.map((d, i) => <NativeSelectOption key={d.deviceId} value={d.deviceId}>{d.label || `Speaker ${i + 1}`}</NativeSelectOption>)}
              </NativeSelect>
            </div>
          )}
        </div>
        {!devices.labelled && !blocked && (
          <div className="flex items-center gap-3">
            <p className="m-0 grow text-sm text-muted-foreground">Allow microphone access to see your devices' names.</p>
            <Button variant="outline" size="sm" onClick={() => void allow()}>Allow microphone access</Button>
          </div>
        )}
        {blocked && <p className="m-0 text-sm text-destructive" role="alert">Microphone blocked — allow it in your browser's site settings.</p>}
      </Card>

      <Card role="region" aria-label="Input mode" className="gap-3 p-4">
        <h3>Input mode</h3>
        <Choices name="input-mode" label="Input mode" value={p.mode} options={modes} onChange={setInputMode} />
        {p.mode === "vad" ? (
          <div className="grid gap-2">
            <div className="flex items-center gap-3">
              <Label htmlFor="vad-auto" className="grow font-medium">Automatically determine input sensitivity</Label>
              <Switch id="vad-auto" checked={p.vadAuto} onCheckedChange={setVadAuto} />
            </div>
            <LevelMeter reading={reading} thresholdDb={p.vadAuto ? reading?.thresholdDb : p.vadThresholdDb} />
            <Slider aria-label="Input sensitivity" min={-100} max={0} step={1} disabled={p.vadAuto}
              value={[p.vadAuto ? Math.round(reading?.thresholdDb ?? p.vadThresholdDb) : p.vadThresholdDb]}
              onValueChange={([db]) => setVadThreshold(db)} />
          </div>
        ) : (
          <div className="grid gap-2">
            <div className="flex items-center gap-3">
              <span className="grow font-medium">Push-to-talk key</span>
              <KeyCapture value={p.pttKey} onChange={setPttKey} />
            </div>
            <LevelMeter reading={reading} />
          </div>
        )}
        {inCall ? (
          <p className="m-0 text-sm text-muted-foreground">Showing your microphone in the call.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => setTesting((t) => !t)}>{testing ? "Stop checking" : "Let's check"}</Button>
            {testing && (
              <Label htmlFor="mic-monitor" className="flex items-center gap-2 font-normal">
                <Switch id="mic-monitor" checked={monitor} onCheckedChange={setMonitor} />Hear yourself (use headphones)
              </Label>
            )}
            {testError && <span className="text-sm text-destructive" role="alert">{testError}</span>}
          </div>
        )}
      </Card>

      <Card role="region" aria-label="Noise suppression" className="gap-3 p-4">
        <h3>Noise suppression</h3>
        <Choices name="noise" label="Noise suppression" value={p.noise} options={noises} onChange={setNoise} />
        {p.noise === "enhanced" && reading?.enhancedFailed && (
          <p className="m-0 text-sm text-muted-foreground" role="status">Enhanced noise suppression isn't available in this browser, so Standard is used.</p>
        )}
      </Card>
    </>
  );
}
```

  Notes for the implementer:
  - Check whether `native-select.tsx` exports `NativeSelectOption`. If not, use plain `<option>`.
  - Remove the eslint-disable comment if the repo has no eslint (check `package.json`: it has none, so drop it).
  - **Spec gap closed:** when Enhanced fails, the spec says to "use Standard". That needs a capture restart
    with `noiseSuppression: true`. Keep it simple: when `enhancedFailed` is set, `MicChain` passes audio
    through without RNNoise, and the note says so. The browser filter stays off, because restarting capture
    from inside the processor is not possible. Change the note text to:
    "Enhanced noise suppression isn't available in this browser. Choose Standard instead."
- [ ] **Step 4:** Run `rtk tsc -p tsconfig.json` and `rtk vitest run`. Expected: both pass. The
  `settings-store.test.ts` tests are unaffected.
- [ ] **Step 5:** `rtk git add src/app/settings/VoiceSettings.tsx src/app/settings/settings-store.ts src/app/settings/UserSettingsDialog.tsx`

### Task 9: E2E and browser verification

**Files:** modify `e2e/chat.spec.ts`.

- [ ] **Step 1: settings e2e.** Insert this after the Appearance block (after its
  `await alice.keyboard.press("Escape");`, around line 389):

```ts
  // Voice & audio: push to talk shows the key and hides sensitivity; the choice stays on this device.
  await alice.getByRole("button", { name: "Your settings" }).click();
  await alice.getByRole("dialog").getByRole("button", { name: "Voice & audio" }).click();
  await expect(alice.getByLabel("Input device")).toBeVisible();
  await expect(alice.getByRole("slider", { name: "Input sensitivity" })).toBeVisible();
  await alice.getByRole("radio", { name: "Push to talk" }).click();
  await expect(alice.getByRole("button", { name: /^Push-to-talk key/ })).toBeVisible();
  await expect(alice.getByRole("slider", { name: "Input sensitivity" })).toHaveCount(0);
  await alice.reload();
  await alice.getByRole("button", { name: "Your settings" }).click();
  await alice.getByRole("dialog").getByRole("button", { name: "Voice & audio" }).click();
  await expect(alice.getByRole("radio", { name: "Push to talk" })).toBeChecked();
  await alice.getByRole("radio", { name: "Voice activity" }).click();
  await alice.keyboard.press("Escape");
```

  Check first whether this block runs after the voice section of the test. If it does, the reload would
  disconnect a call; the Appearance block is at ~line 383 and voice is at ~263, so the call has already
  ended by then. Also check that the page has no unsaved state that a reload would lose. Use `alice.reload()`
  only if later steps don't depend on in-memory state. If unsure, drop the reload and only assert the toggle.

- [ ] **Step 2: quality e2e.** In the voice block, after bob's `Voice connected` assertion, add:

```ts
  await expect(alice.getByRole("button", { name: /^Connection quality: / })).toBeVisible();
```

- [ ] **Step 3: browser check (manual, built-in browser).**
  - Start `datrope-server` and the web preview from `.claude/launch.json`, with the dev LiveKit container
    running.
  - Join a voice channel and check:
    - the signal icon appears and its label updates within about 4 s
    - Settings → Voice & audio renders all three cards
    - the meter moves (fake/real mic)
    - switching to Push to talk silences the meter's green until the key is held
    - Enhanced shows no error in the console
  - Read the console for errors. Take a screenshot as proof.
- [ ] **Step 4:** Run e2e locally if the stack is available (see memory "Local dev environment": the e2e
  compose override is in an earlier session's scratchpad). Otherwise rely on CI and state that clearly.
- [ ] **Step 5:** Run `rtk tsc -p tsconfig.json`, `rtk vitest run` and `rtk pnpm build` (in `clients/web`).
  Expected: all pass. The build proves the `?worker&url` worklet and the wasm assets bundle.
- [ ] **Step 6:** `rtk git add e2e/chat.spec.ts`

---

## Self-review notes

- **Spec coverage:**

  | Spec item | Task |
  |---|---|
  | quality | 4, 7 |
  | devices | 1, 6, 8 |
  | VAD / auto / threshold | 2, 5, 8 |
  | PTT | 3, 6, 8 |
  | noise Off / Standard / Enhanced | 1, 5, 6, 8 |
  | mic test + monitor | 5, 8 |
  | output to soundboard + sounds | 6 |
  | error fallbacks | 5 (RNNoise, processor), 6 (device), 8 (permission) |
  | e2e | 9 |

- **Spec deviations:** the worklet gate, `NativeSelect`, the slider under the meter, and the
  Enhanced-failure note (no automatic switch to the browser filter).
- **Types used across tasks:**
  - `ChainOptions` is defined in `audio-prefs.ts`.
  - `GateSettings` is defined in `gate.ts`.
  - `Meter` and `GateMessage` are defined in `gate-worklet.ts`; `mic-processor.ts` re-exports `Meter`.
  - `Quality` and `UNKNOWN` are defined in `stats.ts`.
