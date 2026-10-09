import type { ThreadListItem } from "@datrope/core";

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60], ["minute", 60], ["hour", 24], ["day", 7], ["week", 4.35], ["month", 12], ["year", Infinity],
];

/** "5 minutes ago", "yesterday", "3 weeks ago"; under a minute is "now". */
export function timeAgo(iso: string, now = Date.now()): string {
  let n = (Date.parse(iso) - now) / 1000;
  if (n > -60) return relative.format(0, "second");
  for (const [unit, size] of STEPS) {
    if (Math.abs(n) < size) return relative.format(Math.round(n), unit);
    n /= size;
  }
  return relative.format(Math.round(n), "year");
}

export const repliesText = (n: number) => (n === 1 ? "1 reply" : `${n} replies`);

const ID_EPOCH = 1767225600000; // server/internal/id: 2026-01-01T00:00:00Z

/** When a thread was last active: its last reply, else when it was created (from its Snowflake ID). */
function activity(t: ThreadListItem): number {
  const created = Number(BigInt(t.channel.id) >> 22n) + ID_EPOCH;
  return Math.max(created, t.summary.last_message_at ? Date.parse(t.summary.last_message_at) : 0);
}

/** Most recently active first. */
export const byActivity = (items: ThreadListItem[]) => [...items].sort((a, b) => activity(b) - activity(a));
