export type Track = { key: string; title: string; subtitle: string; src: string; channelId?: string; attachmentId?: string; cover?: string };
export type Repeat = "off" | "all" | "one";
export type Queue = { tracks: Track[]; index: number };

export const EMPTY: Queue = { tracks: [], index: -1 };

export function start(tracks: Track[], at = 0): Queue {
  return tracks.length ? { tracks, index: Math.min(Math.max(at, 0), tracks.length - 1) } : EMPTY;
}

/** Appends tracks whose key is not already queued (or repeated within `tracks`); on an empty queue it starts. */
export function enqueue(q: Queue, tracks: Track[]): Queue {
  const seen = new Set(q.tracks.map((x) => x.key));
  const fresh: Track[] = [];
  for (const x of tracks) {
    if (seen.has(x.key)) continue;
    seen.add(x.key);
    fresh.push(x);
  }
  if (q.index < 0) return start(fresh);
  return fresh.length ? { ...q, tracks: [...q.tracks, ...fresh] } : q;
}

/** The next track after the current one ends (or Next is pressed with repeat off/all). */
export function advance(q: Queue, repeat: Repeat): Queue | null {
  if (q.index < 0) return null;
  if (repeat === "one") return q;
  if (q.index + 1 < q.tracks.length) return { ...q, index: q.index + 1 };
  return repeat === "all" ? { ...q, index: 0 } : null;
}

export function back(q: Queue): Queue {
  return q.index > 0 ? { ...q, index: q.index - 1 } : q;
}

export function removeAt(q: Queue, i: number): Queue {
  const tracks = q.tracks.filter((_, j) => j !== i);
  if (!tracks.length) return EMPTY;
  const index = i < q.index ? q.index - 1 : Math.min(q.index, tracks.length - 1);
  return { tracks, index };
}

export function moveTo(q: Queue, from: number, to: number): Queue {
  const tracks = [...q.tracks];
  const [moved] = tracks.splice(from, 1);
  tracks.splice(to, 0, moved);
  return { tracks, index: tracks.indexOf(q.tracks[q.index]) };
}

/** Shuffles the tracks after the current one (Fisher–Yates). */
export function shuffleUpcoming(q: Queue, rand: () => number = Math.random): Queue {
  const head = q.tracks.slice(0, q.index + 1);
  const rest = q.tracks.slice(q.index + 1);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return { tracks: [...head, ...rest], index: q.index };
}
