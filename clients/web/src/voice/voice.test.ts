import { Track } from "livekit-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../session", () => ({ client: { onEvent: () => {}, store: { getState: () => ({}), subscribe: () => () => {} } }, permsIn: () => 0 }));
vi.mock("../sounds", () => ({ play: () => {} }));
vi.mock("./mixer", () => ({ applyPrefs: () => {}, watchPrefs: () => () => {} }));

const { voice } = await import("./voice");

const settings = { mode: "game", resolution: 1080, fps: 60, audio: true } as const;

type Raw = { kind: string; readyState: string; stop: ReturnType<typeof vi.fn>; applyConstraints: () => Promise<void>; contentHint: string };
function raw(kind: string): Raw {
  const t: Raw = { kind, readyState: "live", stop: vi.fn(() => void (t.readyState = "ended")), applyConstraints: async () => {}, contentHint: "" };
  return t;
}

/** Every capture the browser's picker hands out, in order. `pick` decides each call's outcome. */
const captured: Raw[] = [];
let pick: () => "screen" | "closed" = () => "screen";
vi.stubGlobal("navigator", {
  mediaDevices: {
    getDisplayMedia: vi.fn(async (opts: { audio: boolean }) => {
      if (pick() === "closed") throw new DOMException("closed", "NotAllowedError");
      const ts = [raw("video"), ...(opts.audio ? [raw("audio")] : [])];
      captured.push(...ts);
      return { getVideoTracks: () => [ts[0]], getAudioTracks: () => ts.slice(1) };
    }),
  },
});

/** LiveKit's wrapper around a published MediaStreamTrack. */
function wrap(mst: Raw) {
  const t = {
    kind: mst.kind, mediaStreamTrack: mst, sender: undefined, publishOptions: {},
    setDegradationPreference: vi.fn(async () => {}),
    replaceTrack: vi.fn(async (next: Raw) => {
      t.mediaStreamTrack = next;
    }),
  };
  return t;
}

/** A room whose local participant publishes into a map; `publish` decides each publishTrack's outcome. */
function fakeRoom(publish: (source: Track.Source) => Promise<void> = async () => {}) {
  type Pub = { track: ReturnType<typeof wrap>; videoTrack?: unknown; audioTrack?: unknown; options: Record<string, unknown> };
  const pubs = new Map<Track.Source, Pub>();
  const lp = {
    get isScreenShareEnabled() {
      return pubs.has(Track.Source.ScreenShare);
    },
    getTrackPublication: (s: Track.Source) => pubs.get(s),
    publishTrack: vi.fn(async (mst: Raw, o: { source: Track.Source }) => {
      await publish(o.source);
      const t = wrap(mst);
      pubs.set(o.source, { track: t, videoTrack: mst.kind === "video" ? t : undefined, audioTrack: mst.kind === "audio" ? t : undefined, options: { ...o } });
    }),
    unpublishTrack: vi.fn(async (t: unknown) => {
      await new Promise((r) => setTimeout(r, 20)); // a signal round trip
      for (const [s, p] of pubs) if (p.track === t) pubs.delete(s);
    }),
    setScreenShareEnabled: vi.fn(async (on: boolean) => {
      if (!on) {
        pubs.delete(Track.Source.ScreenShare);
        pubs.delete(Track.Source.ScreenShareAudio);
      }
    }),
  };
  return { room: { localParticipant: lp, remoteParticipants: new Map() }, lp, pubs };
}

function use(room: unknown) {
  (voice as unknown as { room: unknown }).room = room;
  voice.store.setState({ status: "connected", error: undefined, stream: undefined, screen: false });
}

describe("screen share", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.length = 0;
    pick = () => "screen";
  });

  it("stops the capture when publishing fails", async () => {
    const f = fakeRoom(async () => {
      throw new Error("no permission");
    });
    use(f.room);
    await voice.startScreen(settings);
    expect(captured.every((t) => t.stop.mock.calls.length > 0)).toBe(true);
    expect(voice.store.getState()).toMatchObject({ error: "Could not share your screen.", stream: undefined, screen: false });
  });

  it("does not stay live without a menu when the audio fails to publish", async () => {
    const f = fakeRoom(async (s) => {
      if (s === Track.Source.ScreenShareAudio) throw new Error("timeout");
    });
    use(f.room);
    await voice.startScreen(settings);
    expect(f.lp.setScreenShareEnabled).toHaveBeenCalledWith(false);
    expect(captured[1]!.stop).toHaveBeenCalled(); // the audio was never handed to LiveKit
    expect(voice.store.getState()).toMatchObject({ screen: false, stream: undefined });
  });

  it("applies quick changes one after another, each on top of the last", async () => {
    const f = fakeRoom();
    use(f.room);
    await voice.startScreen(settings);
    expect(voice.store.getState().stream).toEqual(settings);
    const a = voice.applyStream({ audio: false }); // waits on an unpublish round trip
    const b = voice.applyStream({ fps: 30 });
    await Promise.all([a, b]);
    expect(voice.store.getState().stream).toEqual({ ...settings, audio: false, fps: 30 });
    expect(f.lp.getTrackPublication(Track.Source.ScreenShareAudio)).toBeUndefined();
  });

  it("keeps a live change for a reconnect, which republishes with the publish options", async () => {
    const f = fakeRoom();
    use(f.room);
    await voice.startScreen(settings);
    await voice.applyStream({ resolution: 720, fps: 30 });
    const pub = f.pubs.get(Track.Source.ScreenShare)!;
    expect(pub.options.videoEncoding).toEqual({ maxBitrate: 3_000_000, maxFramerate: 30 });
    expect(pub.track.publishOptions).toMatchObject({ videoEncoding: { maxBitrate: 3_000_000, maxFramerate: 30 } });
  });

  it("keeps sharing the same thing when the picker is closed during a source change", async () => {
    const f = fakeRoom();
    use(f.room);
    await voice.startScreen(settings);
    pick = () => "closed";
    await voice.changeSource();
    expect(voice.store.getState()).toMatchObject({ error: undefined, stream: settings });
    expect(f.pubs.get(Track.Source.ScreenShare)!.track.mediaStreamTrack).toBe(captured[0]);
  });

  it("swaps the old source back when a source change fails half way", async () => {
    const f = fakeRoom();
    use(f.room);
    await voice.startScreen(settings);
    const first = captured[0]!;
    f.pubs.get(Track.Source.ScreenShareAudio)!.track.replaceTrack = vi.fn(async () => {
      throw new Error("sender closed"); // the video swapped fine; the audio swap fails
    });
    await voice.changeSource();
    const video = f.pubs.get(Track.Source.ScreenShare)!.track;
    expect(video.mediaStreamTrack).toBe(first);
    expect(first.stop).not.toHaveBeenCalled();
    expect(captured.slice(2).every((t) => t.stop.mock.calls.length > 0)).toBe(true); // the new capture is let go
    expect(voice.store.getState()).toMatchObject({ error: "Could not change what you share.", stream: settings });
  });
});
