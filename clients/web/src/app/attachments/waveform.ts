/** Larger files are not decoded for a waveform: the whole file would be downloaded and held in memory. */
export const MAX_WAVEFORM_BYTES = 16 << 20;
export const BARS = 64;

/** The loudest sample of each of `bars` equal slices, across all channels, scaled so the loudest bar is 1. */
export function peaks(channels: Float32Array[], bars = BARS): number[] {
  const length = channels[0]?.length ?? 0;
  const out = new Array<number>(bars).fill(0);
  if (length === 0) return out;
  for (let b = 0; b < bars; b++) {
    const start = Math.floor((b * length) / bars);
    const end = Math.max(start + 1, Math.floor(((b + 1) * length) / bars));
    let max = 0;
    for (const data of channels) {
      for (let i = start; i < end && i < length; i++) {
        const v = Math.abs(data[i]);
        if (v > max) max = v;
      }
    }
    out[b] = max;
  }
  const loudest = Math.max(...out);
  return loudest > 0 ? out.map((v) => v / loudest) : out;
}

const cache = new Map<string, Promise<number[]>>();

/** Downloads and decodes an audio file once and returns its waveform. */
export function loadWaveform(url: string): Promise<number[]> {
  let p = cache.get(url);
  if (!p) {
    p = (async () => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // A low sample rate is plenty for a waveform and keeps the decoded copy small.
      const audio = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(await res.arrayBuffer());
      const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
      return peaks(channels);
    })();
    p.catch(() => cache.delete(url)); // let a later mount retry
    cache.set(url, p);
  }
  return p;
}
