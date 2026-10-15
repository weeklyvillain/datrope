import { getClockPref, type ClockPref } from "./clock-pref";

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const formats = new Map<string, Intl.DateTimeFormat>();
const fmt = (locale: string | undefined, kind: string, opts: Intl.DateTimeFormatOptions) => {
  const key = `${locale ?? ""}|${kind}`;
  let f = formats.get(key);
  if (!f) formats.set(key, f = new Intl.DateTimeFormat(locale, opts));
  return f;
};

/** The clock is 12-hour: by choice, or (auto) because the locale uses one. */
const twelve = (locale?: string, pref: ClockPref = getClockPref()) =>
  pref === "12" || (pref === "auto" && /h1[12]/.test(fmt(locale, "hour", { hour: "numeric" }).resolvedOptions().hourCycle ?? ""));
/** "08:33" or "8:33 AM", by the clock preference. */
export const clockTime = (d: Date, locale?: string, pref: ClockPref = getClockPref()) =>
  (twelve(locale, pref) ? fmt(locale, "clock12", { hour: "numeric", minute: "2-digit", hourCycle: "h12" }) : fmt(locale, "clock24", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })).format(d);

/** A message group's time: "Today 08:33", "Yesterday 21:10", or "9 Oct 2026 08:33". */
export function headStamp(d: Date, now = new Date(), locale?: string): string {
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = clockTime(d, locale);
  if (sameDay(d, now)) return `Today ${time}`;
  if (sameDay(d, yesterday)) return `Yesterday ${time}`;
  return `${fmt(locale, "date", { day: "numeric", month: "short", year: "numeric" }).format(d)} ${time}`;
}

/** The full date and time, for tooltips. */
export const fullStamp = (d: Date, locale?: string, pref: ClockPref = getClockPref()) => {
  const h12 = twelve(locale, pref);
  return fmt(locale, h12 ? "full12" : "full24", { dateStyle: "full", timeStyle: "short", hourCycle: h12 ? "h12" : "h23" }).format(d);
};
