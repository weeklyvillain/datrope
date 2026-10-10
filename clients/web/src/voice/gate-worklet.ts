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
