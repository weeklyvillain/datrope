import { beforeEach, describe, expect, it, vi } from "vitest";

/** The shell side: what the picker answers, and the frame channel it was handed. */
let answer: { gen: number; settings?: unknown } | null = { gen: 7 };
let onFrame: ((m: unknown) => void) | undefined;
let pickedWith: unknown;
const stopScreen = vi.fn();
vi.mock("../desktop", () => ({
  desktop: {
    pickScreen: vi.fn(async (_fps: number, cb: (m: unknown) => void, settings?: unknown) => {
      onFrame = cb;
      pickedWith = settings;
      return answer;
    }),
    stopScreen: () => stopScreen(),
  },
}));

/** WebView2's chrome.webview: delivers shared buffers to listeners. */
const bufferListeners = new Set<(e: unknown) => void>();
const released: ArrayBuffer[] = [];
function postBuffer(gen: number, slotSize: number, buffer = new ArrayBuffer(slotSize * 3)) {
  for (const cb of bufferListeners) cb({ getBuffer: () => buffer, additionalData: { datropeScreen: gen, slots: 3, slotSize } });
  return buffer;
}

const written: { init: Record<string, unknown>; bytes: number }[] = [];
class FakeGenerator extends EventTarget {
  readyState = "live";
  contentHint = "";
  writable = { getWriter: () => ({ desiredSize: 1, write: async () => {}, close: async () => {} }) };
  stop() {
    this.readyState = "ended";
  }
}
class FakeVideoFrame {
  constructor(data: Uint8Array, init: Record<string, unknown>) {
    written.push({ init, bytes: data.byteLength });
  }
  close() {}
}

vi.stubGlobal("window", {
  chrome: {
    webview: {
      addEventListener: (_t: string, cb: (e: unknown) => void) => bufferListeners.add(cb),
      removeEventListener: (_t: string, cb: (e: unknown) => void) => bufferListeners.delete(cb),
      releaseBuffer: (b: ArrayBuffer) => released.push(b),
    },
  },
  MediaStreamTrackGenerator: FakeGenerator,
});
vi.stubGlobal("VideoFrame", FakeVideoFrame);

const { captureNativeScreen, nativeScreenAvailable, nativeScreenSize } = await import("./native-screen");

/** Starts a capture whose first frame arrives right after the picker answers. */
async function capture(gen = 7) {
  answer = { gen };
  const p = captureNativeScreen(30).then((c) => c?.track);
  await vi.waitFor(() => expect(onFrame).toBeDefined());
  await Promise.resolve();
  postBuffer(gen, 16);
  onFrame!({ gen, slot: 1, width: 2, height: 2, timestamp: 5 });
  return p;
}

beforeEach(() => {
  onFrame = undefined;
  written.length = 0;
  released.length = 0;
  bufferListeners.clear();
  stopScreen.mockClear();
});

describe("native screen capture", () => {
  it("is used inside the desktop app's WebView2", () => {
    expect(nativeScreenAvailable()).toBe(true);
  });

  it("turns shared-buffer frames into a video track", async () => {
    const track = (await capture())!;
    expect(track).toBeInstanceOf(FakeGenerator);
    expect(written).toEqual([{ init: { format: "BGRX", codedWidth: 2, codedHeight: 2, timestamp: 5 }, bytes: 16 }]);
    expect(nativeScreenSize(track)).toEqual({ width: 2, height: 2 });
  });

  it("ignores frames and buffers of other captures", async () => {
    await capture(7);
    postBuffer(8, 16); // a newer capture's buffer: not ours
    onFrame!({ gen: 8, slot: 0, width: 2, height: 2 });
    onFrame!({ gen: 7, slot: 9, width: 0, height: 2 }); // malformed
    expect(written).toHaveLength(1);
  });

  it("passes the settings to the picker and returns the ones chosen there", async () => {
    const offered = { mode: "game", resolution: 1080, fps: 60, audio: true } as const;
    const chosen = { ...offered, resolution: 720 } as const;
    answer = { gen: 9, settings: chosen };
    const p = captureNativeScreen(60, offered);
    await vi.waitFor(() => expect(onFrame).toBeDefined());
    await Promise.resolve();
    postBuffer(9, 16);
    onFrame!({ gen: 9, slot: 0, width: 2, height: 2 });
    const got = (await p)!;
    expect(pickedWith).toEqual(offered);
    expect(got.settings).toEqual(chosen);
    expect(got.track).toBeInstanceOf(FakeGenerator);
  });

  it("gives nothing when the picker is cancelled", async () => {
    answer = null;
    expect(await captureNativeScreen(30)).toBeUndefined();
    expect(bufferListeners.size).toBe(0);
    expect(stopScreen).not.toHaveBeenCalled();
  });

  it("stops the shell's capture when the track stops", async () => {
    const track = (await capture())!;
    track.stop();
    expect(stopScreen).toHaveBeenCalledTimes(1);
    expect(released).toHaveLength(1);
    expect(track.readyState).toBe("ended");
  });

  it("ends the track when the shared window closes", async () => {
    const track = (await capture())!;
    const ended = vi.fn();
    track.addEventListener("ended", ended);
    onFrame!({ gen: 7, ended: true });
    expect(ended).toHaveBeenCalled();
    expect(track.readyState).toBe("ended");
    expect(stopScreen).toHaveBeenCalledTimes(1);
  });
});
