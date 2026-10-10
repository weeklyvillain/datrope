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
