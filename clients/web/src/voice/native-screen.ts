import { desktop } from "../desktop";
import type { StreamSettings } from "./stream-prefs";

/**
 * Screen share through the desktop app's own picker (Windows, WebView2). The shell captures the screen or window
 * the user picked and writes frames into a buffer it shares with this page (a few slots, reused); each frame comes
 * with a small message saying which slot holds it. This turns those frames into a video MediaStreamTrack.
 */

/** A frame (or the end of the capture) from the shell. `gen` tells captures apart. */
interface FrameMessage {
  gen: number;
  slot?: number;
  width?: number;
  height?: number;
  timestamp?: number;
  ended?: boolean;
}

/** What the shell sends with the shared buffer. */
interface BufferInfo {
  datropeScreen: number;
  slots: number;
  slotSize: number;
}

interface SharedBufferEvent extends Event {
  getBuffer(): ArrayBuffer;
  additionalData: unknown;
}

/** The part of WebView2's `chrome.webview` this uses. */
interface HostWebview {
  addEventListener(type: "sharedbufferreceived", cb: (e: SharedBufferEvent) => void): void;
  removeEventListener(type: "sharedbufferreceived", cb: (e: SharedBufferEvent) => void): void;
  releaseBuffer(buffer: ArrayBuffer): void;
}

/** Chromium's MediaStreamTrackGenerator (not in TypeScript's DOM types). */
interface TrackGenerator extends MediaStreamTrack {
  readonly writable: WritableStream<VideoFrame>;
}
type TrackGeneratorClass = new (init: { kind: "video" }) => TrackGenerator;

const hostWebview = () => (window as { chrome?: { webview?: HostWebview } }).chrome?.webview;
const Generator = () => (window as unknown as { MediaStreamTrackGenerator?: TrackGeneratorClass }).MediaStreamTrackGenerator;

/** Whether screen share goes through the desktop app's picker instead of the browser's. */
export function nativeScreenAvailable(): boolean {
  return !!desktop && !!hostWebview() && !!Generator();
}

const sizes = new WeakMap<MediaStreamTrack, { width: number; height: number }>();

/** The size of a native capture's latest frame (the encoder scales it down); undefined for other tracks. */
export function nativeScreenSize(track: MediaStreamTrack) {
  return sizes.get(track);
}

const FIRST_FRAME_WAIT_MS = 2000;

/**
 * Opens the app's picker and captures what the user picks at up to `fps`. With `settings` the picker offers the
 * stream quality too, and `settings` comes back with what was chosen there. Undefined if the picker was closed.
 * Stopping the track stops the capture; when the shared window closes the track ends (an `ended` event).
 */
export async function captureNativeScreen(
  fps: number, settings?: StreamSettings,
): Promise<{ track: MediaStreamTrack; settings?: StreamSettings } | undefined> {
  const wv = hostWebview()!;
  const track = new (Generator()!)({ kind: "video" });
  const writer = track.writable.getWriter();
  const stopTrack = track.stop.bind(track);
  let gen: number | undefined = undefined; // known once the picker answers
  let buffer: ArrayBuffer | undefined;
  let info: BufferInfo | undefined;
  let done = false;
  let firstFrame: () => void = () => undefined;
  const gotFirstFrame = new Promise<void>((resolve) => (firstFrame = resolve));

  const release = () => {
    if (buffer) {
      try { wv.releaseBuffer(buffer); } catch { /* already closed by the shell */ }
    }
    buffer = info = undefined;
  };

  // Every capture in this page sees every buffer: take only this capture's (any while it doesn't know its own yet).
  const onBuffer = (e: SharedBufferEvent) => {
    const d = e.additionalData as Partial<BufferInfo> | null;
    if (typeof d?.datropeScreen !== "number" || (gen !== undefined && d.datropeScreen !== gen)) return;
    release();
    buffer = e.getBuffer();
    info = d as BufferInfo;
  };

  const cleanup = () => {
    done = true;
    wv.removeEventListener("sharedbufferreceived", onBuffer);
    release();
    void writer.close().catch(() => undefined);
  };

  const onFrame = (m: FrameMessage) => {
    if (done || (gen !== undefined && m.gen !== gen)) return;
    if (m.ended) {
      if (gen === undefined) return;
      cleanup();
      desktop?.stopScreen();
      stopTrack();
      track.dispatchEvent(new Event("ended"));
      return;
    }
    const { slot, width, height, timestamp } = m;
    if (!buffer || !info || info.datropeScreen !== m.gen || slot === undefined || !width || !height) return;
    if (writer.desiredSize !== null && writer.desiredSize <= 0) return; // the encoder is behind: drop this one
    const frame = new VideoFrame(new Uint8Array(buffer, slot * info.slotSize, width * height * 4), {
      format: "BGRX", codedWidth: width, codedHeight: height, timestamp: timestamp ?? 0,
    });
    sizes.set(track, { width, height });
    firstFrame();
    writer.write(frame).catch(() => frame.close());
  };

  wv.addEventListener("sharedbufferreceived", onBuffer);
  let started: { gen: number; settings?: StreamSettings } | null;
  try {
    started = await desktop!.pickScreen<FrameMessage>(fps, onFrame, settings);
  } catch (e) {
    cleanup();
    throw e;
  }
  if (started === null) {
    cleanup();
    stopTrack();
    return undefined;
  }
  gen = started.gen;
  if (info && info.datropeScreen !== gen) release();

  track.stop = () => {
    if (!done) {
      cleanup();
      desktop?.stopScreen();
    }
    stopTrack();
  };
  // Publish once there is a picture (and a size to scale from), but don't hang on a source that draws nothing.
  await Promise.race([gotFirstFrame, new Promise((r) => setTimeout(r, FIRST_FRAME_WAIT_MS))]);
  return { track, settings: started.settings };
}
