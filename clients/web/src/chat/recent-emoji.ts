const KEY = "datrope.recentEmoji";
export const DEFAULT_QUICK = ["👍", "❤️", "😂", "🔥", "🎉", "👀"];

export function mergeRecent(list: string[], key: string, max = 12): string[] {
  return [key, ...list.filter((k) => k !== key)].slice(0, max);
}
function load(): string[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; }
  catch { return []; }
}
/** Remembers an emoji someone reacted with or inserted. */
export function recordEmoji(key: string) {
  try { localStorage.setItem(KEY, JSON.stringify(mergeRecent(load(), key))); } catch { /* storage unavailable */ }
}
/** The quick-reaction row: recent picks first, topped up with defaults. */
export function quickReactions(n = 6): string[] {
  const out = load().filter((k) => !k.startsWith("custom:")).slice(0, n);
  for (const d of DEFAULT_QUICK) if (out.length < n && !out.includes(d)) out.push(d);
  return out;
}
