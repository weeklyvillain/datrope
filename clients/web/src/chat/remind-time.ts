// Turns what someone types or picks into the instant a reminder is due, in local time.
// Pure: callers pass `now`.

import { clockTime } from "@/lib/message-time";

const MIN = 60_000;
// Three-letter and full English day names.
const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
export const DAYS = 14; // the wheel dialog's day choices

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
const atTime = (day: Date, h: number, m: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
const dayDiff = (a: Date, b: Date) => Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86_400_000);
/** The next `weekday` (0 = Sunday) after today: a week out when today is that day. */
const nextWeekday = (now: Date, weekday: number) => addDays(startOfDay(now), (weekday - now.getDay() + 7) % 7 || 7);

export function presets(now: Date): { label: string; due: Date }[] {
  return [
    { label: "In 20 minutes", due: new Date(now.getTime() + 20 * MIN) },
    { label: "In 1 hour", due: new Date(now.getTime() + 60 * MIN) },
    { label: "In 3 hours", due: new Date(now.getTime() + 180 * MIN) },
    { label: "Tomorrow", due: atTime(addDays(startOfDay(now), 1), 9, 0) },
    { label: "Next week", due: atTime(nextWeekday(now, 1), 9, 0) },
  ];
}

const DURATION = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/i;
const CLOCK = /^(\d{1,2}):(\d{2})$/;
const HOUR = /^(\d{1,2})(?::(\d{2}))?$/;

function clock(h: number, m: number): [number, number] | null {
  return h < 24 && m < 60 ? [h, m] : null;
}

/** `/remind`'s <when>: 20m, 2h, 1h30m, 1d, 14:30, tomorrow [9|14:30], mon–sun [9|14:30]; the rest is the text. */
export function parseWhen(text: string, now: Date): { due: Date; rest: string } | null {
  const words = text.trim().split(/\s+/);
  const [first = "", second = ""] = words;
  const rest = (n: number) => words.slice(n).join(" ");

  const d = DURATION.exec(first);
  if (first && d) {
    const mins = Number(d[1] ?? 0) * 1440 + Number(d[2] ?? 0) * 60 + Number(d[3] ?? 0);
    return mins > 0 && mins <= 366 * 1440 ? { due: new Date(now.getTime() + mins * MIN), rest: rest(1) } : null;
  }
  const c = CLOCK.exec(first);
  if (c) {
    const t = clock(Number(c[1]), Number(c[2]));
    if (!t) return null;
    let due = atTime(now, ...t);
    if (due <= now) due = atTime(addDays(startOfDay(now), 1), ...t);
    return { due, rest: rest(1) };
  }
  const lower = first.toLowerCase();
  const weekday = WEEKDAYS[lower] ?? -1;
  const day = lower === "tomorrow" ? addDays(startOfDay(now), 1) : weekday >= 0 ? nextWeekday(now, weekday) : null;
  if (!day) return null;
  const h = HOUR.exec(second);
  if (h) {
    const t = clock(Number(h[1]), Number(h[2] ?? 0));
    return t ? { due: atTime(day, ...t), rest: rest(2) } : null;
  }
  return { due: atTime(day, 9, 0), rest: rest(1) };
}

const fmt = (locale: string | undefined, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, opts);

/** "Today 15:04", "Tomorrow 09:00", "Fri 13:00", "30 Oct 13:30", "3 Jan 2027 09:00". */
export function whenLabel(due: Date, now: Date, locale?: string): string {
  const time = clockTime(due, locale);
  const days = dayDiff(now, due);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days > 1 && days < 7) return `${fmt(locale, { weekday: "short" }).format(due)} ${time}`;
  const sameYear = due.getFullYear() === now.getFullYear();
  return `${fmt(locale, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }).format(due)} ${time}`;
}

/** The time beside a preset: just the clock today. */
export const menuTime = (due: Date, now: Date, locale?: string) =>
  dayDiff(now, due) === 0 ? clockTime(due, locale) : whenLabel(due, now, locale);

/** "in 5 min", "in 18 h 58 min", "in 2 d 3 h"; null unless due is in the future. */
export function relative(due: Date, now: Date): string | null {
  const mins = Math.ceil((due.getTime() - now.getTime()) / MIN);
  if (mins <= 0) return null;
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (d > 0) return `in ${d} d${h ? ` ${h} h` : ""}`;
  if (h > 0) return `in ${h} h${m ? ` ${m} min` : ""}`;
  return `in ${m} min`;
}

export type Pick = { day: number; hour: number; minute: number };

export function dayLabels(now: Date, locale?: string): string[] {
  const f = fmt(locale, { weekday: "short", day: "numeric", month: "short" });
  return Array.from({ length: DAYS }, (_, i) => (i === 0 ? "Today" : i === 1 ? "Tomorrow" : f.format(addDays(startOfDay(now), i)).replace(",", "")));
}

export const pickToDate = (now: Date, p: Pick) => atTime(addDays(startOfDay(now), p.day), p.hour, p.minute);

/** The wheel position for `due`: minutes rounded up to 5, at most the last day. */
export function pickFor(now: Date, due: Date): Pick {
  const up = new Date(Math.ceil(due.getTime() / (5 * MIN)) * 5 * MIN);
  const day = dayDiff(now, up);
  if (day > DAYS - 1) return { day: DAYS - 1, hour: up.getHours(), minute: up.getMinutes() };
  return { day: Math.max(0, day), hour: up.getHours(), minute: up.getMinutes() };
}

/** The next full quarter hour, plus an hour. */
export function defaultPick(now: Date): Pick {
  const q = 15 * MIN;
  return pickFor(now, new Date(Math.floor(now.getTime() / q) * q + q + 60 * MIN));
}
