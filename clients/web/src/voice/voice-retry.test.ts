import { DisconnectReason, RoomEvent } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted with the mocks below, which run before this file's imports.
const { joinVoice, goAFK, rooms, FakeRoom, app, events } = vi.hoisted(() => {
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
  // The app's state: voice channels 42, 43 and the AFK channel 9 (one minute of silence).
  const app = {
    me: { id: "7" }, channels: { "42": { type: "voice" }, "43": { type: "voice" }, "9": { type: "voice" } },
    server: { server: { afk_channel_id: "9", afk_timeout_seconds: 60 } },
  };
  const events: ((type: string, data: unknown) => void)[] = [];
  return {
    joinVoice: vi.fn(async () => ({ url: "wss://lk", token: "t" })), goAFK: vi.fn(async () => {}), rooms, FakeRoom, app, events,
  };
});
vi.mock("../session", () => ({
  client: {
    onEvent: (fn: (type: string, data: unknown) => void) => events.push(fn), joinVoice, goAFK, setVoiceSelf: async () => {},
    sendPing: async () => {}, store: { getState: () => app, subscribe: () => () => {} },
  },
  permsIn: () => 0,
}));
vi.mock("../sounds", () => ({ play: () => {} }));
vi.mock("./mixer", () => ({ applyPrefs: () => {}, watchPrefs: () => () => {} }));
vi.mock("./call-audio", () => ({ CallAudio: class { setMic = async () => {}; stop() {} } }));
vi.mock("./stats", async (orig) => ({ ...(await orig<typeof import("./stats")>()), watchQuality: () => () => {} }));

vi.mock("livekit-client", async (orig) => ({ ...(await orig<typeof import("livekit-client")>()), Room: FakeRoom }));

const { voice } = await import("./voice");
const { teamsStore } = await import("./teams");
const { pingStore } = await import("./pings");
const emit = (type: string, data: unknown) => events.forEach((fn) => fn(type, data));

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

describe("a call's draw and peer pings", () => {
  const draw = { channel_id: "42", by: "7", teams: [["7"], ["8"]], bench: [], per_team: 0, at: "" };
  const seed = () => {
    teamsStore.setState({ draw });
    pingStore.setState({ byUser: { "8": { rttMs: 40, at: 0 } } });
  };
  beforeEach(() => {
    vi.useFakeTimers();
    rooms.length = 0;
  });
  afterEach(() => {
    voice.leave();
    vi.useRealTimers();
  });

  it("survive our own rejoin after a lost connection", async () => {
    await connected();
    seed();
    rooms.at(-1)!.emit(RoomEvent.Disconnected, DisconnectReason.SIGNAL_CLOSE);
    await vi.advanceTimersByTimeAsync(1000);
    expect(voice.store.getState().status).toBe("connected");
    expect(teamsStore.getState().draw).toBe(draw);
    expect(pingStore.getState().byUser).toHaveProperty("8");
  });
  it("are dropped on leaving", async () => {
    await connected();
    seed();
    voice.leave();
    expect(teamsStore.getState().draw).toBeUndefined();
    expect(pingStore.getState().byUser).toEqual({});
  });
  it("are dropped on switching to another channel", async () => {
    await connected();
    seed();
    await voice.join("43");
    expect(teamsStore.getState().draw).toBeUndefined();
    expect(pingStore.getState().byUser).toEqual({});
  });
});

describe("going AFK", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rooms.length = 0;
    goAFK.mockClear();
  });
  afterEach(() => {
    voice.leave();
    vi.useRealTimers();
  });

  it("does not while my camera or screen is on", async () => {
    await connected();
    voice.store.setState({ screen: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(goAFK).not.toHaveBeenCalled();
    voice.store.setState({ screen: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(goAFK).toHaveBeenCalledTimes(1);
  });
  it("says why once moved to the AFK channel", async () => {
    await connected();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(goAFK).toHaveBeenCalledTimes(1);
    emit("VOICE_MOVE", { channel_id: "9" });
    await vi.advanceTimersByTimeAsync(0);
    expect(voice.store.getState()).toMatchObject({ channelId: "9", status: "connected", notice: "Moved to AFK after 1 min of silence" });
  });
  it("does not say so when a moderator moves me elsewhere meanwhile", async () => {
    await connected();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(goAFK).toHaveBeenCalledTimes(1);
    emit("VOICE_MOVE", { channel_id: "43" });
    await vi.advanceTimersByTimeAsync(0);
    expect(voice.store.getState()).toMatchObject({ channelId: "43", status: "connected", notice: undefined });
  });
});
