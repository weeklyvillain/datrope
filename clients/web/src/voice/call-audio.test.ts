import { beforeEach, describe, expect, it, vi } from "vitest";

// Node has no window: push to talk listens on a plain EventTarget here.
globalThis.window = new EventTarget() as Window & typeof globalThis;

/** Stands in for LiveKit's LocalAudioTrack: records what was done to it. */
class FakeTrack {
  muted = false;
  failProcessor = false;
  processor?: unknown;
  calls: string[] = [];
  async mute() {
    this.muted = true;
    this.calls.push("mute");
  }
  async unmute() {
    this.muted = false;
    this.calls.push("unmute");
  }
  getProcessor() {
    return this.processor;
  }
  async setProcessor(p: unknown) {
    this.calls.push("setProcessor");
    if (this.failProcessor) throw new Error("no AudioWorklet");
    this.processor = p;
  }
  async stopProcessor() {
    this.processor = undefined;
  }
}

const next: { failProcessor: boolean } = { failProcessor: false };
const created: FakeTrack[] = [];
vi.mock("livekit-client", () => ({
  Track: { Source: { Microphone: "microphone" } },
  createLocalAudioTrack: vi.fn(async () => {
    const t = new FakeTrack();
    t.failProcessor = next.failProcessor;
    created.push(t);
    return t;
  }),
}));
vi.mock("./mic-processor", () => ({
  MicProcessor: class {
    setOptions() {}
    setPtt() {}
    destroy = vi.fn(async () => undefined);
  },
}));
vi.mock("./output", () => ({ canPickOutput: () => false }));

const { CallAudio } = await import("./call-audio");
const { audioDefaults, audioPrefs } = await import("./audio-prefs");

function fakeRoom() {
  const log: string[] = [];
  let pub: { audioTrack: FakeTrack } | undefined;
  const localParticipant = {
    getTrackPublication: () => pub,
    publishTrack: vi.fn(async (t: FakeTrack) => {
      log.push(`publish muted=${t.muted}`);
      pub = { audioTrack: t };
    }),
    setMicrophoneEnabled: vi.fn(async (on: boolean) => {
      log.push(`enabled ${on}`);
      if (pub) await (on ? pub.audioTrack.unmute() : pub.audioTrack.mute());
    }),
  };
  const room = { localParticipant, options: {}, switchActiveDevice: vi.fn(async () => true) };
  return { room, log, localParticipant };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("call audio", () => {
  beforeEach(() => {
    audioPrefs.setState(audioDefaults, true);
    created.length = 0;
    next.failProcessor = false;
  });

  it("publishes the first mic track muted and unmutes it only once the processor is on", async () => {
    const { room, log } = fakeRoom();
    const audio = new CallAudio(room as never, () => undefined);
    await audio.setMic(true);
    expect(log[0]).toBe("publish muted=true");
    const t = created[0];
    expect(t.calls.indexOf("setProcessor")).toBeLessThan(t.calls.lastIndexOf("unmute"));
    expect(t.muted).toBe(false);
    audio.stop();
  });

  it("keeps the mic muted in push to talk when the processor fails", async () => {
    audioPrefs.setState({ mode: "ptt" });
    next.failProcessor = true;
    const { room, localParticipant } = fakeRoom();
    const errors: string[] = [];
    const audio = new CallAudio(room as never, (e) => errors.push(e));
    await audio.setMic(true);
    expect(created[0].muted).toBe(true);
    expect(localParticipant.setMicrophoneEnabled).not.toHaveBeenCalledWith(true);
    expect(errors).toHaveLength(1);
    audio.stop();
  });

  it("sends the raw mic in voice activity when the processor fails", async () => {
    next.failProcessor = true;
    const { room } = fakeRoom();
    const audio = new CallAudio(room as never, () => undefined);
    await audio.setMic(true);
    expect(created[0].muted).toBe(false);
    audio.stop();
  });

  it("starts the mic once when asked twice at the same time", async () => {
    const { room } = fakeRoom();
    const audio = new CallAudio(room as never, () => undefined);
    await Promise.all([audio.setMic(true), audio.setMic(true)]);
    expect(created).toHaveLength(1);
    expect(created[0].calls.filter((c) => c === "setProcessor")).toHaveLength(1);
    audio.stop();
  });

  it("switches devices without demanding an exact match", async () => {
    const { room } = fakeRoom();
    const audio = new CallAudio(room as never, () => undefined);
    audioPrefs.setState({ inputDeviceId: "default" === audioPrefs.getState().inputDeviceId ? "mic-2" : "default" });
    await flush();
    expect(room.switchActiveDevice).toHaveBeenCalledWith("audioinput", "mic-2", false);
    audioPrefs.setState({ inputDeviceId: "default" });
    await flush();
    expect(room.switchActiveDevice).toHaveBeenLastCalledWith("audioinput", "default", false);
    audio.stop();
  });

  it("destroys the processor when the call ends", () => {
    const { room } = fakeRoom();
    const audio = new CallAudio(room as never, () => undefined);
    audio.stop();
    expect((audio.processor as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).toHaveBeenCalled();
  });
});
