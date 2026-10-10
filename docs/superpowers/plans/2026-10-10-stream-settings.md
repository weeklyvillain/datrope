# Stream Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Screen shares default to smooth 1080p60 gameplay, with a Go Live dialog (Game/Detail mode, resolution, fps, audio) and a live stream menu that changes source and settings without stopping the stream.

**Architecture:** A device-only settings store plus a pure `encoding()` function (`voice/stream-prefs.ts`) decide capture size, fps, bitrate, content hint and degradation. `voice/voice.ts` publishes the screen share itself (H.264, no simulcast) instead of `setScreenShareEnabled(true)`, swaps sources with `LocalTrack.replaceTrack`, and re-tunes the live sender with `applyConstraints` + `RTCRtpSender.setParameters`. The UI is a shared `StreamFields` form used by `GoLiveDialog` (before going live) and `StreamMenuContent` (while live).

**Tech Stack:** React 18 · zustand · livekit-client 2.22.3 · shadcn/ui (new-york, Radix) + Tailwind v4 · Vitest (Node, no jsdom) · Playwright.

**Spec:** `docs/superpowers/specs/2026-10-10-stream-settings-design.md`

## Global Constraints

- **Never commit.** Each task ends with a checkpoint: stage with `git add`; the user commits.
- Write project files with Bash heredocs or the scratchpad + `cp` (the Write/Edit tools are blocked for project files on this machine). Tell subagents this up front.
- Scope: `clients/web` only. No backend or LiveKit server changes.
- Default settings: `{ mode: "game", resolution: 1080, fps: 60, audio: true }`. Mode defaults: Game → 1080p60, Detail → 1080p30.
- Bitrates: 720p30 3 Mbps · 720p60 4.5 Mbps · 1080p30 5 Mbps · 1080p60 10 Mbps.
- Game: `contentHint "motion"`, `degradationPreference "maintain-framerate"`. Detail: `"detail"`, `"maintain-resolution"`.
- Screen share video: `videoCodec: "h264"`, `simulcast: false`. Cameras unchanged.
- `localStorage` key `datrope.streamPrefs`; each invalid stored field falls back to its default.
- Error strings: "Could not share your screen." · "Could not change what you share." · "Could not apply stream settings." · "Could not stop sharing."
- UI: shadcn components first (add `toggle-group` with `pnpm dlx shadcn@latest add toggle-group` from `clients/web`; fallback per AGENTS.md §6). Tokens only, no `dark:` classes, `cn()` from `@/lib/utils`, `@/` imports. React 18: use `RefButton` (`@/components/ref-button`) as an `asChild` trigger.
- Keep the "Share screen" accessible name on the voice panel control.
- Commands run from `clients/web`: `pnpm test`, `pnpm typecheck`, `pnpm exec eslint src`.

## Review Focus

- Closing the browser picker during **Change source** (or **Audio on**) → stream continues unchanged, no error. (Task 2 `changeSource` returns early on `undefined` capture; Task 4 manual check.)
- The browser's own **Stop sharing** bar, leaving voice, or switching channel while live → `stream` becomes `undefined`, menu closes, control unpressed. (Task 2 `refresh()` clears `stream`, `idle` has `stream: undefined`; Task 5 e2e stops and checks the tile is gone.)
- A source swap after a live bitrate change → LiveKit's `refreshSenderEncodings` recomputes encodings from the publish options; ours must be re-applied. (Task 2 `changeSource` calls `tune` after `replaceTrack`.)
- A live change the browser refuses (60 fps on window capture) → previous settings re-applied, error shown, stream alive. (Task 2 `applyStream` catch path.)
- Tampered or partial `datrope.streamPrefs` → defaults per field. (Task 1 test "ignores tampered storage".)

---

### Task 1: Stream settings store and encoding

**Files:**
- Create: `clients/web/src/voice/stream-prefs.ts`
- Test: `clients/web/src/voice/stream-prefs.test.ts`

**Interfaces:**
- Produces:
  - `type StreamMode = "game" | "detail"`
  - `interface StreamSettings { mode: StreamMode; resolution: 720 | 1080; fps: 30 | 60; audio: boolean }`
  - `interface StreamEncoding { width: number; height: number; fps: 30 | 60; maxBitrate: number; contentHint: "motion" | "detail"; degradationPreference: RTCDegradationPreference }`
  - `encoding(s: StreamSettings): StreamEncoding`
  - `withMode(s: StreamSettings, mode: StreamMode): StreamSettings` — sets mode and that mode's default resolution/fps, keeps `audio`.
  - `streamPrefs` (zustand vanilla store of `StreamSettings`), `useStreamPrefs<T>(selector)`, `saveStreamPrefs(s: StreamSettings)`.

- [ ] **Step 1: Write the failing test** — `clients/web/src/voice/stream-prefs.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encoding, saveStreamPrefs, streamPrefs, withMode } from "./stream-prefs";

// Vitest runs in Node (no jsdom here): a tiny in-memory localStorage.
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

describe("stream prefs", () => {
  beforeEach(() => {
    data.clear();
    streamPrefs.setState(streamPrefs.getInitialState(), true);
  });

  it("defaults to game mode at 1080p60 with audio", () => {
    expect(streamPrefs.getState()).toEqual({ mode: "game", resolution: 1080, fps: 60, audio: true });
  });

  it("encodes each preset", () => {
    const game = { mode: "game", audio: true } as const;
    expect(encoding({ ...game, resolution: 720, fps: 30 }).maxBitrate).toBe(3_000_000);
    expect(encoding({ ...game, resolution: 720, fps: 60 }).maxBitrate).toBe(4_500_000);
    expect(encoding({ ...game, resolution: 1080, fps: 30 }).maxBitrate).toBe(5_000_000);
    expect(encoding({ ...game, resolution: 1080, fps: 60 })).toEqual({
      width: 1920, height: 1080, fps: 60, maxBitrate: 10_000_000,
      contentHint: "motion", degradationPreference: "maintain-framerate",
    });
    expect(encoding({ ...game, resolution: 720, fps: 30 })).toMatchObject({ width: 1280, height: 720, fps: 30 });
  });

  it("keeps text sharp in detail mode", () => {
    expect(encoding({ mode: "detail", resolution: 1080, fps: 30, audio: false })).toMatchObject({
      contentHint: "detail", degradationPreference: "maintain-resolution",
    });
  });

  it("applies a mode's defaults and keeps audio", () => {
    expect(withMode({ mode: "game", resolution: 720, fps: 60, audio: false }, "detail"))
      .toEqual({ mode: "detail", resolution: 1080, fps: 30, audio: false });
    expect(withMode({ mode: "detail", resolution: 720, fps: 30, audio: true }, "game"))
      .toEqual({ mode: "game", resolution: 1080, fps: 60, audio: true });
  });

  it("saves to this device", () => {
    saveStreamPrefs({ mode: "detail", resolution: 720, fps: 30, audio: false });
    expect(JSON.parse(localStorage.getItem("datrope.streamPrefs")!)).toEqual({ mode: "detail", resolution: 720, fps: 30, audio: false });
  });

  it("ignores tampered storage", async () => {
    localStorage.setItem("datrope.streamPrefs", '{"mode":"cinema","resolution":1440,"fps":30,"audio":"yes"}');
    vi.resetModules();
    const fresh = await import("./stream-prefs");
    expect(fresh.streamPrefs.getState()).toEqual({ mode: "game", resolution: 1080, fps: 30, audio: true });
    localStorage.setItem("datrope.streamPrefs", "not json");
    vi.resetModules();
    expect((await import("./stream-prefs")).streamPrefs.getState()).toEqual({ mode: "game", resolution: 1080, fps: 60, audio: true });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run (from `clients/web`): `pnpm test -- stream-prefs`
Expected: FAIL — cannot resolve `./stream-prefs`.

- [ ] **Step 3: Implement** — `clients/web/src/voice/stream-prefs.ts`:

```ts
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

export type StreamMode = "game" | "detail";

/** What I send when I share my screen. Kept on this device; the dialog opens with the last ones used. */
export interface StreamSettings {
  mode: StreamMode;
  resolution: 720 | 1080;
  fps: 30 | 60;
  audio: boolean;
}

/** What the browser and LiveKit need for one set of stream settings. */
export interface StreamEncoding {
  width: number;
  height: number;
  fps: 30 | 60;
  maxBitrate: number; // bits per second
  contentHint: "motion" | "detail";
  degradationPreference: RTCDegradationPreference;
}

const KEY = "datrope.streamPrefs";

const MODE_DEFAULTS: Record<StreamMode, Pick<StreamSettings, "resolution" | "fps">> = {
  game: { resolution: 1080, fps: 60 },
  detail: { resolution: 1080, fps: 30 },
};

const defaults: StreamSettings = { mode: "game", ...MODE_DEFAULTS.game, audio: true };

const BITRATE: Record<StreamSettings["resolution"], Record<StreamSettings["fps"], number>> = {
  720: { 30: 3_000_000, 60: 4_500_000 },
  1080: { 30: 5_000_000, 60: 10_000_000 },
};

export function encoding(s: StreamSettings): StreamEncoding {
  const game = s.mode === "game";
  return {
    width: s.resolution === 1080 ? 1920 : 1280,
    height: s.resolution,
    fps: s.fps,
    maxBitrate: BITRATE[s.resolution][s.fps],
    // Game: under pressure lose resolution, keep fps. Detail: keep text sharp, lose fps.
    contentHint: game ? "motion" : "detail",
    degradationPreference: game ? "maintain-framerate" : "maintain-resolution",
  };
}

/** Switches mode and takes that mode's resolution and fps; audio stays as it was. */
export function withMode(s: StreamSettings, mode: StreamMode): StreamSettings {
  return { ...s, mode, ...MODE_DEFAULTS[mode] };
}

function load(): StreamSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return defaults;
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (!p || typeof p !== "object") return defaults;
    return {
      mode: p.mode === "game" || p.mode === "detail" ? p.mode : defaults.mode,
      resolution: p.resolution === 720 || p.resolution === 1080 ? p.resolution : defaults.resolution,
      fps: p.fps === 30 || p.fps === 60 ? p.fps : defaults.fps,
      audio: typeof p.audio === "boolean" ? p.audio : defaults.audio,
    };
  } catch {
    return defaults; // unavailable or unreadable: settings then last for this session
  }
}

export const streamPrefs = createStore<StreamSettings>(() => load());

streamPrefs.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable (private window): kept in memory only.
  }
});

export function saveStreamPrefs(s: StreamSettings) {
  streamPrefs.setState(s, true);
}

/** Subscribes a component to this device's stream settings. */
export function useStreamPrefs<T>(selector: (s: StreamSettings) => T): T {
  return useStore(streamPrefs, selector);
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm test -- stream-prefs` → PASS (6 tests). Then `pnpm typecheck` → no errors.

- [ ] **Step 5: Checkpoint** — `git add clients/web/src/voice/stream-prefs.ts clients/web/src/voice/stream-prefs.test.ts`. Suggested message: `feat(web): stream settings and encoding presets`

---

### Task 2: Publish, swap and tune the screen share in `voice.ts`

**Files:**
- Modify: `clients/web/src/voice/voice.ts` (imports; `VoiceView`; `idle`; `refresh()`; replace `toggleScreen()` at lines 296–308)
- Modify: `clients/web/src/app/voice/VoicePanel.tsx:59-62` (temporary: call `startScreen`/`stopScreen` so the build stays green until Task 4)

**Interfaces:**
- Consumes: `encoding`, `streamPrefs`, `StreamSettings` from `./stream-prefs` (Task 1).
- Produces on `voice`:
  - `VoiceView.stream?: StreamSettings` — what is sent now; `undefined` when not live.
  - `startScreen(s: StreamSettings): Promise<void>`
  - `changeSource(s?: StreamSettings): Promise<void>` — `s` defaults to the live settings.
  - `applyStream(s: StreamSettings): Promise<void>`
  - `stopScreen(): Promise<void>`
  - `toggleScreen()` is removed.

No unit tests: `voice.ts` needs a browser and LiveKit (Vitest runs in Node). Covered by typecheck here, manual checks, and the e2e in Task 5.

LiveKit facts this relies on (checked in livekit-client 2.22.3): `LocalParticipant.createScreenTracks(options)` opens `getDisplayMedia` and sets `contentHint`; `LocalTrack.replaceTrack(mst)` keeps the publication and calls `refreshSenderEncodings()` (recomputed from publish options, so `tune` must run after it); `LocalVideoTrack.sender`, `setDegradationPreference()` exist; `setScreenShareEnabled(false)` also unpublishes `ScreenShareAudio`; the `ended` listener moves to the new track on replace, and LiveKit unpublishes screen tracks on `ended`.

- [ ] **Step 1: State** — in `voice.ts`:
  - type imports from `livekit-client`: add `type LocalAudioTrack`.
  - add `import { encoding, type StreamSettings } from "./stream-prefs";`
  - `VoiceView`: after `screen: boolean;` add `stream?: StreamSettings; // what my screen share sends now; undefined when not live`
  - `idle`: add `stream: undefined,` after `screen: false,`.
  - `refresh()`: replace its final `this.set(...)` with:

```ts
    const screen = lp.isScreenShareEnabled;
    // Cleared here too, so the browser's own "Stop sharing" bar (LiveKit unpublishes on `ended`) resets the menu.
    this.set({ tiles, camera: !!lp.getTrackPublication(Track.Source.Camera)?.track, screen, ...(!screen && { stream: undefined }) });
```

- [ ] **Step 2: Replace `toggleScreen()`** (lines 296–308) with:

```ts
  /** Opens the browser's screen picker; undefined when the picker was closed. */
  private async capture(s: StreamSettings) {
    const lp = this.room!.localParticipant;
    const e = encoding(s);
    try {
      const tracks = await lp.createScreenTracks({
        audio: s.audio, contentHint: e.contentHint,
        resolution: { width: e.width, height: e.height, frameRate: e.fps },
      });
      return {
        video: tracks.find((t): t is LocalVideoTrack => t.kind === Track.Kind.Video)!,
        audio: tracks.find((t): t is LocalAudioTrack => t.kind === Track.Kind.Audio),
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotAllowedError") return undefined; // picker closed
      throw err;
    }
  }

  /** Applies settings to the live screen share: capture size and fps, content hint, bitrate and degradation. */
  private async tune(s: StreamSettings) {
    const track = this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack as LocalVideoTrack | undefined;
    if (!track) return;
    const e = encoding(s);
    const mst = track.mediaStreamTrack;
    await mst.applyConstraints({ width: { max: e.width }, height: { max: e.height }, frameRate: { ideal: e.fps, max: e.fps } });
    mst.contentHint = e.contentHint;
    const sender = track.sender;
    if (sender) {
      const params = sender.getParameters();
      for (const enc of params.encodings) {
        enc.maxBitrate = e.maxBitrate;
        enc.maxFramerate = e.fps;
        enc.scaleResolutionDownBy = 1; // the capture is already the chosen size
      }
      await sender.setParameters(params);
    }
    await track.setDegradationPreference(e.degradationPreference);
  }

  /** Goes live: the browser's picker chooses the source, `s` the quality. */
  async startScreen(s: StreamSettings) {
    const room = this.room;
    const lp = room?.localParticipant;
    if (!room || !lp || lp.isScreenShareEnabled) return;
    try {
      const got = await this.capture(s);
      if (!got) return;
      if (this.room !== room) {
        got.video.stop();
        got.audio?.stop();
        return;
      }
      const e = encoding(s);
      // One full-quality layer: simulcast could leave viewers stuck on a low one. H.264 is hardware-encoded where possible.
      await lp.publishTrack(got.video, {
        source: Track.Source.ScreenShare, videoCodec: "h264", simulcast: false,
        videoEncoding: { maxBitrate: e.maxBitrate, maxFramerate: e.fps }, degradationPreference: e.degradationPreference,
      });
      if (got.audio) await lp.publishTrack(got.audio, { source: Track.Source.ScreenShareAudio });
      await this.tune(s);
      if (this.room === room) this.set({ stream: { ...s, audio: !!got.audio } });
    } catch {
      if (this.room === room) this.set({ error: "Could not share your screen." });
    }
    if (this.room === room) this.refresh();
  }

  /** Shares something else without stopping: the publications stay, so viewers keep watching. */
  async changeSource(s = this.store.getState().stream) {
    const room = this.room;
    const lp = room?.localParticipant;
    const video = lp?.getTrackPublication(Track.Source.ScreenShare)?.videoTrack as LocalVideoTrack | undefined;
    if (!room || !lp || !s || !video) return;
    try {
      const got = await this.capture(s);
      if (!got) return; // picker closed: keep sharing what I was
      if (this.room !== room || lp.getTrackPublication(Track.Source.ScreenShare)?.track !== video) {
        got.video.stop();
        got.audio?.stop();
        return;
      }
      const oldVideo = video.mediaStreamTrack;
      await video.replaceTrack(got.video.mediaStreamTrack);
      oldVideo.stop();
      const oldAudio = lp.getTrackPublication(Track.Source.ScreenShareAudio)?.audioTrack as LocalAudioTrack | undefined;
      if (got.audio && oldAudio) {
        const m = oldAudio.mediaStreamTrack;
        await oldAudio.replaceTrack(got.audio.mediaStreamTrack);
        m.stop();
      } else if (got.audio) {
        await lp.publishTrack(got.audio, { source: Track.Source.ScreenShareAudio });
      } else if (oldAudio) {
        await lp.unpublishTrack(oldAudio);
      }
      await this.tune(s); // replaceTrack recomputed encodings from the publish options; put mine back
      if (this.room === room) this.set({ stream: { ...s, audio: !!got.audio } });
    } catch {
      if (this.room === room) this.set({ error: "Could not change what you share." });
    }
    if (this.room === room) this.refresh();
  }

  /** Changes quality while live. Turning audio on needs a new capture, so it asks for the source again. */
  async applyStream(next: StreamSettings) {
    const room = this.room;
    const lp = room?.localParticipant;
    const prev = this.store.getState().stream;
    if (!room || !lp || !prev) return;
    if (next.audio && !prev.audio) return this.changeSource(next);
    try {
      if (!next.audio && prev.audio) {
        const audio = lp.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
        if (audio) await lp.unpublishTrack(audio);
      }
      await this.tune(next);
      if (this.room === room) this.set({ stream: next });
    } catch {
      if (this.room !== room) return;
      await this.tune(prev).catch(() => undefined);
      const audio = !!lp.getTrackPublication(Track.Source.ScreenShareAudio);
      this.set({ stream: { ...prev, audio }, error: "Could not apply stream settings." });
    }
  }

  /** Stops sharing (screen and its audio). */
  async stopScreen() {
    const room = this.room;
    const lp = room?.localParticipant;
    if (!lp) return;
    try {
      await lp.setScreenShareEnabled(false);
    } catch {
      if (this.room === room) this.set({ error: "Could not stop sharing." });
    }
    if (this.room === room) this.refresh();
  }
```

- [ ] **Step 3: Keep the panel compiling** — in `VoicePanel.tsx` replace `onPressedChange={() => void voice.toggleScreen()}>` with:

```tsx
              onPressedChange={() => void (v.screen ? voice.stopScreen() : voice.startScreen(streamPrefs.getState()))}>
```

and add `import { streamPrefs } from "../../voice/stream-prefs";`. (Task 4 replaces this with the dialog and menu.)

- [ ] **Step 4: Verify**

Run (from `clients/web`): `pnpm typecheck` → no errors; `pnpm test` → all pass; `pnpm exec eslint src/voice src/app/voice` → clean.
Then manually, with the `datrope-web` preview and the dev LiveKit container running (see `.claude/launch.json`): join a voice channel, click Share screen, pick a screen. In `chrome://webrtc-internals` the outbound video shows codec H264, about 60 fps, one encoding (no `rid`s). Click Share screen again to stop; start again and close the picker → no error shown.

- [ ] **Step 5: Checkpoint** — `git add clients/web/src/voice/voice.ts clients/web/src/app/voice/VoicePanel.tsx`. Suggested message: `feat(web): publish screen share as one H.264 layer with live tuning and source swap`

---

### Task 3: Stream fields and the Go Live dialog

**Files:**
- Create (CLI): `clients/web/src/components/ui/toggle-group.tsx`
- Create: `clients/web/src/app/voice/StreamFields.tsx`
- Create: `clients/web/src/app/voice/GoLiveDialog.tsx`

**Interfaces:**
- Consumes: `StreamSettings`, `StreamMode`, `withMode`, `saveStreamPrefs`, `streamPrefs` (Task 1); `voice.startScreen` (Task 2).
- Produces:
  - `StreamFields({ value, onChange }: { value: StreamSettings; onChange: (s: StreamSettings) => void })`
  - `GoLiveDialog({ onClose }: { onClose: () => void })`

- [ ] **Step 1: Add the toggle group** — from `clients/web`: `pnpm dlx shadcn@latest add toggle-group`. Check `src/components/ui/toggle-group.tsx` exists, imports `@/lib/utils` and `@/components/ui/toggle`, and has no `dark:` classes (strip any). If the CLI fails, fetch `https://ui.shadcn.com/r/styles/new-york-v4/toggle-group.json` and write its file by hand (AGENTS.md §6).

- [ ] **Step 2: Shared fields** — `clients/web/src/app/voice/StreamFields.tsx`:

```tsx
import { Gamepad2, Type } from "lucide-react";
import { useId } from "react";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { withMode, type StreamMode, type StreamSettings } from "../../voice/stream-prefs";

const MODES: { value: StreamMode; label: string; hint: string; icon: typeof Gamepad2 }[] = [
  { value: "game", label: "Game", hint: "Smooth motion, 60 fps", icon: Gamepad2 },
  { value: "detail", label: "Detail", hint: "Sharp text, for code and documents", icon: Type },
];

/** Mode, resolution, frame rate and audio for a screen share; used before going live and while live. */
export function StreamFields({ value, onChange }: { value: StreamSettings; onChange: (s: StreamSettings) => void }) {
  const id = useId();
  return (
    <div className="grid gap-4">
      <RadioGroup aria-label="Mode" value={value.mode} onValueChange={(m) => onChange(withMode(value, m as StreamMode))}
        className="grid grid-cols-2 gap-2">
        {MODES.map((m) => (
          <Label key={m.value} htmlFor={`${id}-${m.value}`} className={cn(
            "grid cursor-pointer gap-1 rounded-lg border p-3 font-normal",
            value.mode === m.value && "border-primary bg-accent",
          )}>
            <span className="flex items-center gap-2 font-medium">
              <RadioGroupItem value={m.value} id={`${id}-${m.value}`} />
              <m.icon className="size-4" /> {m.label}
            </span>
            <span className="text-xs text-muted-foreground">{m.hint}</span>
          </Label>
        ))}
      </RadioGroup>
      <div className="grid gap-1.5">
        <span id={`${id}-res`} className="text-sm text-muted-foreground">Resolution</span>
        <ToggleGroup type="single" variant="outline" aria-labelledby={`${id}-res`} value={String(value.resolution)}
          onValueChange={(r) => r && onChange({ ...value, resolution: Number(r) as StreamSettings["resolution"] })}>
          <ToggleGroupItem value="720">720p</ToggleGroupItem>
          <ToggleGroupItem value="1080">1080p</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="grid gap-1.5">
        <span id={`${id}-fps`} className="text-sm text-muted-foreground">Frame rate</span>
        <ToggleGroup type="single" variant="outline" aria-labelledby={`${id}-fps`} value={String(value.fps)}
          onValueChange={(f) => f && onChange({ ...value, fps: Number(f) as StreamSettings["fps"] })}>
          <ToggleGroupItem value="30">30 fps</ToggleGroupItem>
          <ToggleGroupItem value="60">60 fps</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={`${id}-audio`}>Share audio</Label>
        <Switch id={`${id}-audio`} checked={value.audio} onCheckedChange={(audio) => onChange({ ...value, audio })} />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: The dialog** — `clients/web/src/app/voice/GoLiveDialog.tsx`:

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { saveStreamPrefs, streamPrefs } from "../../voice/stream-prefs";
import { voice } from "../../voice/voice";
import { StreamFields } from "./StreamFields";

/** Picks how to stream; the browser's own picker then chooses what. */
export function GoLiveDialog({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState(() => streamPrefs.getState());
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Go Live</DialogTitle>
          <DialogDescription>Your browser asks what to share next.</DialogDescription>
        </DialogHeader>
        <StreamFields value={settings} onChange={setSettings} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => {
            saveStreamPrefs(settings);
            onClose();
            void voice.startScreen(settings); // same click, so getDisplayMedia keeps the user gesture
          }}>Go Live</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Verify** — `pnpm typecheck`, `pnpm exec eslint src/app/voice src/components/ui/toggle-group.tsx` → clean. The dialog is wired up in Task 4.

- [ ] **Step 5: Checkpoint** — `git add clients/web/src/components/ui/toggle-group.tsx clients/web/src/app/voice/StreamFields.tsx clients/web/src/app/voice/GoLiveDialog.tsx` (plus `clients/web/package.json` only if the CLI changed it). Suggested message: `feat(web): Go Live dialog with stream mode, resolution, fps and audio`

---

### Task 4: Stream menu, voice panel and my screen tile

**Files:**
- Create: `clients/web/src/app/voice/StreamMenu.tsx`
- Modify: `clients/web/src/app/voice/VoicePanel.tsx` (Share screen control)
- Modify: `clients/web/src/app/voice/Tile.tsx` (gear on my own screen tile)

**Interfaces:**
- Consumes: `StreamFields`, `GoLiveDialog` (Task 3); `voice.changeSource/applyStream/stopScreen`, `VoiceView.stream` (Task 2); `saveStreamPrefs` (Task 1).
- Produces: `StreamMenuContent({ onDone }: { onDone: () => void })` — the body of a `PopoverContent`.

- [ ] **Step 1: Menu body** — `clients/web/src/app/voice/StreamMenu.tsx`:

```tsx
import { MonitorUp, ScreenShareOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { saveStreamPrefs } from "../../voice/stream-prefs";
import { useVoice, voice } from "../../voice/voice";
import { StreamFields } from "./StreamFields";

/** While live: change what and how I share, or stop. Changes apply at once. */
export function StreamMenuContent({ onDone }: { onDone: () => void }) {
  const stream = useVoice((v) => v.stream);
  if (!stream) return null;
  return (
    <div className="grid gap-3" role="group" aria-label="Stream settings">
      <Button variant="outline" onClick={() => void voice.changeSource()}><MonitorUp /> Change source</Button>
      <Separator />
      <StreamFields value={stream} onChange={(s) => {
        saveStreamPrefs(s);
        void voice.applyStream(s);
      }} />
      <Separator />
      <Button variant="destructive" onClick={() => {
        onDone();
        void voice.stopScreen();
      }}><ScreenShareOff /> Stop streaming</Button>
    </div>
  );
}
```

- [ ] **Step 2: Voice panel** — in `VoicePanel.tsx`:
  - imports: `useState` from `react` (next to `ComponentProps`); `Popover, PopoverAnchor, PopoverContent` from `@/components/ui/popover`; `GoLiveDialog` from `./GoLiveDialog`; `StreamMenuContent` from `./StreamMenu`; remove the Task 2 `streamPrefs` import.
  - at the top of `VoicePanel`, after `const perms = usePerms(v.channelId);` (before the early `return null`, hooks first):

```tsx
  const [goLive, setGoLive] = useState(false);
  const [menu, setMenu] = useState(false);
  if (menu && !v.screen) setMenu(false); // stopped elsewhere (browser bar, tile menu): don't reopen on the next Go Live
```
  - replace the Share screen `<Control …>…</Control>` with:

```tsx
            <Popover open={menu && v.screen} onOpenChange={setMenu}>
              <PopoverAnchor asChild>
                <div className="flex">
                  <Control label="Share screen" tip={v.screen ? "Stream settings" : "Share your screen"} pressed={v.screen}
                    disabled={!canStream} onPressedChange={() => (v.screen ? setMenu(true) : setGoLive(true))}>
                    {v.screen ? <ScreenShareOff /> : <ScreenShare />}
                  </Control>
                </div>
              </PopoverAnchor>
              <PopoverContent side="top" className="w-72"><StreamMenuContent onDone={() => setMenu(false)} /></PopoverContent>
            </Popover>
```

  - after the closing `</div>` of the `grid grid-cols-2` controls add: `{goLive && <GoLiveDialog onClose={() => setGoLive(false)} />}`
  - The `div.flex` is a real DOM node for the popover anchor's ref (React 18: `Control` does not forward refs).

- [ ] **Step 3: Gear on my screen tile** — in `Tile.tsx`:
  - imports: add `Settings2` to the `lucide-react` import; `useState` from `react`; `Popover, PopoverContent, PopoverTrigger` from `@/components/ui/popover`; `RefButton` from `@/components/ref-button`; `StreamMenuContent` from `./StreamMenu`.
  - right after the "Stop watching" block add:

```tsx
      {screen && tile.local && <MyStreamButton />}
```

  - at the bottom of the file:

```tsx
/** Stream settings on my own screen tile. */
function MyStreamButton() {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <RefButton className="absolute right-2 top-2" variant="secondary" size="icon-sm" aria-label="Stream settings">
          <Settings2 />
        </RefButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72"><StreamMenuContent onDone={() => setOpen(false)} /></PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 4: Verify** — `pnpm typecheck`, `pnpm test`, `pnpm exec eslint src` → clean. With the preview running: Share screen opens "Go Live"; Go Live → browser picker → my screen tile appears with a gear; the pressed Share screen control and the gear both open the menu; switching Game → Detail caps fps at 30 in `chrome://webrtc-internals`; Change source keeps the tile; closing the picker during Change source shows no error; Stop streaming removes the tile and unpresses the control; using the browser's "Stop sharing" bar does the same. Screenshot the dialog and the open menu for the user.

- [ ] **Step 5: Checkpoint** — `git add clients/web/src/app/voice/StreamMenu.tsx clients/web/src/app/voice/VoicePanel.tsx clients/web/src/app/voice/Tile.tsx`. Suggested message: `feat(web): live stream menu in the voice panel and on my screen tile`

---

### Task 5: End-to-end test

**Files:**
- Modify: `clients/web/playwright.config.ts` (launch args)
- Modify: `clients/web/e2e/chat.spec.ts` (after bob joins Lounge, before the soundboard step)

**Interfaces:**
- Consumes: the UI from Tasks 3–4 (dialog "Go Live", radio "Detail", switch "Share audio", button "Go Live", control "Share screen", group "Stream settings", buttons "Change source" / "Stop streaming", button "Watch").

- [ ] **Step 1: Auto-pick a screen in Chrome** — `playwright.config.ts` launch args become:

```ts
      launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--auto-select-desktop-capture-source=Entire screen"] },
```

- [ ] **Step 2: The test steps** — in `chat.spec.ts`, right after `await expect(lounge.getByText("bob")).toBeVisible();` add:

```ts
  // Going live: alice picks Detail in the Go Live dialog; bob watches; changing the source keeps bob watching.
  await alice.getByRole("button", { name: "Share screen" }).click();
  const goLive = alice.getByRole("dialog", { name: "Go Live" });
  await goLive.getByRole("radio", { name: /Detail/ }).click();
  await goLive.getByRole("switch", { name: "Share audio" }).click(); // the fake screen has no audio
  await goLive.getByRole("button", { name: "Go Live" }).click();
  const aliceMain = alice.getByRole("main", { name: "Lounge" });
  await expect(aliceMain.getByText("alice's screen")).toBeVisible();
  const bobLounge = bob.getByRole("main", { name: "Lounge" });
  await bobLounge.getByRole("button", { name: "Watch" }).click();
  await expect(bobLounge.getByText("alice's screen")).toBeVisible();
  // The local capture's MediaStreamTrack id changes on a swap; the LiveKit publication (and bob's subscription) stays.
  const captureId = () => alice.evaluate(() => [...document.querySelectorAll<HTMLVideoElement>("main video")]
    .map((v) => (v.srcObject as MediaStream | null)?.getVideoTracks()[0]?.id).join());
  const before = await captureId();
  await alice.getByRole("button", { name: "Share screen" }).click();
  const menu = alice.getByRole("group", { name: "Stream settings" });
  await menu.getByRole("button", { name: "Change source" }).click();
  await expect.poll(captureId).not.toBe(before);
  await expect(bobLounge.getByText("alice's screen")).toBeVisible();
  await expect(alice.getByRole("alert")).toHaveCount(0);
  await menu.getByRole("button", { name: "Stop streaming" }).click();
  await expect(aliceMain.getByText("alice's screen")).toHaveCount(0);
  await expect(bobLounge.getByText("alice's screen")).toHaveCount(0);
```

- [ ] **Step 3: Run it** — the e2e needs a fresh stack every run (local-e2e notes: LiveKit port override compose files, `down -v` then `up --build --wait`), then from `clients/web`: `pnpm e2e`. Expected: PASS. If `alice's screen` never appears, open the trace (`pnpm exec playwright show-trace`) to see whether headless Chrome honoured `--auto-select-desktop-capture-source`; report rather than weaken the test.

- [ ] **Step 4: Checkpoint** — `git add clients/web/playwright.config.ts clients/web/e2e/chat.spec.ts`. Suggested message: `test(web): e2e for Go Live, source change and stop`

- [ ] **Step 5: Manual game check (user)** — stream a real game at Game 1080p60; in `chrome://webrtc-internals` the outbound-rtp shows H264, ~60 fps, ~10 Mbps target; switching to 720p30 in the menu lowers both within seconds.
