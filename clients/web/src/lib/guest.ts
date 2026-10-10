const HOUR = 3600;
const DAY = 24 * HOUR;

/** The guest lifetimes a guest link can have. */
export const GUEST_TTLS = [
  { label: "1 hour", seconds: HOUR },
  { label: "6 hours", seconds: 6 * HOUR },
  { label: "24 hours", seconds: DAY },
  { label: "3 days", seconds: 3 * DAY },
  { label: "7 days", seconds: 7 * DAY },
  { label: "30 days", seconds: 30 * DAY },
];

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** "1 hour", "24 hours", "3 days": a guest link's lifetime. Under two days counts in hours. */
export function guestTtlText(seconds: number): string {
  return seconds < 2 * DAY ? plural(Math.round(seconds / HOUR), "hour") : plural(Math.round(seconds / DAY), "day");
}

/** "6h", "24h", "3d": the same, for a badge. */
export function guestTtlShort(seconds: number): string {
  return seconds < 2 * DAY ? `${Math.round(seconds / HOUR)}h` : `${Math.round(seconds / DAY)}d`;
}

/** "2d 3h", "5h 12m", "12m": what is left of a guest's access. */
export function timeLeft(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "less than a minute";
  const d = Math.floor(min / (24 * 60));
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
