import { useSyncExternalStore } from "react";

export type UnicodeEmoji = { emoji: string; label: string; group: number; shortcodes: string[] };
export type EmojiData = {
  list: UnicodeEmoji[];
  /** list split by group, built once so the picker does not filter on every open */
  byGroup: Map<number, UnicodeEmoji[]>;
  byShortcode: Map<string, string>;
};

type Compact = { hexcode: string; label: string; unicode: string; group?: number };

const COMPONENT_GROUP = 2; // skin tones and hair styles

// The emoji data is large, so it loads lazily (its own chunks) on first use and is cached here.
let data: EmojiData | null = null;
let loading: Promise<EmojiData> | null = null;
const listeners = new Set<() => void>();

/** Loads the Unicode emoji list and GitHub-style shortcodes once. */
export function loadEmojiData(): Promise<EmojiData> {
  loading ??= Promise.all([
    import("emojibase-data/en/compact.json"),
    import("emojibase-data/en/shortcodes/github.json"),
  ]).then(([compact, github]) => {
    const codes = github.default as Record<string, string | string[]>;
    const list: UnicodeEmoji[] = [];
    const byShortcode = new Map<string, string>();
    for (const e of compact.default as Compact[]) {
      const raw = codes[e.hexcode];
      const shortcodes = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
      for (const s of shortcodes) byShortcode.set(s.toLowerCase(), e.unicode);
      // Regional indicators have no group; components are not emoji on their own.
      if (e.group === undefined || e.group === COMPONENT_GROUP) continue;
      list.push({ emoji: e.unicode, label: e.label, group: e.group, shortcodes });
    }
    const byGroup = new Map<number, UnicodeEmoji[]>();
    for (const e of list) {
      const g = byGroup.get(e.group);
      if (g) g.push(e);
      else byGroup.set(e.group, [e]);
    }
    data = { list, byGroup, byShortcode };
    listeners.forEach((l) => l());
    return data;
  });
  loading.catch(() => { loading = null; }); // let a later use retry
  return loading;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!data) void loadEmojiData().catch(() => {});
  return () => listeners.delete(listener);
}

/** The emoji data, or null until it has loaded (the first use starts loading it). */
export function useEmojiData(): EmojiData | null {
  return useSyncExternalStore(subscribe, () => data, () => null);
}
