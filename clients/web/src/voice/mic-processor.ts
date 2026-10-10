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
  private destroyed = false;

  constructor(private opts: ChainOptions) {}

  async init(o: AudioProcessorOptions) {
    this.destroyed = false;
    const chain = await MicChain.create(o.track, this.opts);
    if (this.destroyed) {
      await chain.close(); // the call ended while the worklet was loading
      throw new Error("Mic processor destroyed while starting.");
    }
    chain.setPtt(this.ptt);
    this.chain = chain;
    this.processedTrack = chain.output;
  }

  async restart(o: AudioProcessorOptions) {
    if (!this.chain) return this.init(o);
    await this.chain.setInput(o.track);
  }

  async destroy() {
    this.destroyed = true;
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
