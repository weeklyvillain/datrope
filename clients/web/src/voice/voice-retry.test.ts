import { DisconnectReason, RoomEvent } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted with the mocks below, which run before this file's imports.
const { joinVoice, rooms, FakeRoom } = vi.hoisted(() => {
  /** Every Room the voice client made, newest last; `emit` fires one of its events. */
  const rooms: InstanceType<typeof FakeRoom>[] = [];
  class FakeRoom {
    handlers = new Map<string, (...a: unknown[]) => void>();
    localParticipant = { permissions: undefined, isScreenShareEnabled: false, getTrackPublication: () => undefined };
    remoteParticipants = new Map();
    canPlaybackAudio = true;
    constructor() {
      rooms.push(this);
    }
    on(event: string, fn: (...a: unknown[]) => void) {
      this.handlers.set(event, fn);
      return this;
    }
    emit(event: string, ...a: unknown[]) {
      this.handlers.get(event)?.(...a);
    }
    connect = async () => {};
    disconnect = async () => {};
  }
  return { joinVoice: vi.fn(async () => ({ url: "wss://lk", token: "t" })), rooms, FakeRoom };
});
vi.mock("../session", () => ({
  client: {
    onEvent: () => {}, joinVoice, setVoiceSelf: async () => {},
    store: { getState: () => ({ me: { id: "7" } }), subscribe: () => () => {} },
  },
  permsIn: () => 0,
}));
vi.mock("../sounds", () => ({ play: () => {} }));
vi.mock("./mixer", () => ({ applyPrefs: () => {}, watchPrefs: () => () => {} }));
vi.mock("./call-audio", () => ({ CallAudio: class { setMic = async () => {}; stop() {} } }));
vi.mock("./stats", async (orig) => ({ ...(await orig<typeof import("./stats")>()), watchQuality: () => () => {} }));

vi.mock("livekit-client", async (orig) => ({ ...(await orig<typeof import("livekit-client")>()), Room: FakeRoom }));

const { voice } = await import("./voice");

/** Joins channel 42 and waits until the call is up. */
async function connected() {
  await voice.join("42");
  expect(voice.store.getState().status).toBe("connected");
  joinVoice.mockClear();
}

describe("rejoining after a lost connection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rooms.length = 0;
    joinVoice.mockClear();
  });
  afterEach(() => {
    voice.leave();
    voice.dismiss();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("tries again after one second when the network drops", async () => {
    await connected();
    rooms.at(-1)!.emit(RoomEvent.Disconnected, DisconnectReason.SIGNAL_CLOSE);
    expect(voice.store.getState()).toMatchObject({ status: "reconnecting", retry: 1, channelId: "42" });
    await vi.advanceTimersByTimeAsync(999);
    expect(joinVoice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(joinVoice).toHaveBeenCalledTimes(1);
    expect(voice.store.getState().status).toBe("connected");
  });

  it("tries again at once when the tab is shown again", async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    vi.stubGlobal("document", doc);
    await connected();
    rooms.at(-1)!.emit(RoomEvent.Disconnected, undefined);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(joinVoice).toHaveBeenCalledTimes(1);
    expect(voice.store.getState().status).toBe("connected");
  });

  it("does not rejoin once the user has left during the wait", async () => {
    await connected();
    rooms.at(-1)!.emit(RoomEvent.Disconnected, undefined);
    voice.leave();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(joinVoice).not.toHaveBeenCalled();
    expect(voice.store.getState().status).toBe("idle");
  });

  it("stays out after a kick and says why", async () => {
    await connected();
    rooms.at(-1)!.emit(RoomEvent.Disconnected, DisconnectReason.PARTICIPANT_REMOVED);
    expect(voice.store.getState()).toMatchObject({ status: "idle", retry: undefined, error: "You were disconnected from voice." });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(joinVoice).not.toHaveBeenCalled();
  });
});
