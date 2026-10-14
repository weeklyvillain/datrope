const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const formats = new Map<string, Intl.DateTimeFormat>();
const fmt = (locale: string | undefined, kind: string, opts: Intl.DateTimeFormatOptions) => {
  const key = `${locale ?? ""}|${kind}`;
  let f = formats.get(key);
  if (!f) formats.set(key, f = new Intl.DateTimeFormat(locale, opts));
  return f;
};

/** The locale uses a 12-hour clock. */
const twelve = (locale?: string) => /h1[12]/.test(fmt(locale, "hour", { hour: "numeric" }).resolvedOptions().hourCycle ?? "");
/** "08:33" (24-hour locales) or "8:33 AM" (12-hour locales). */
export const clockTime = (d: Date, locale?: string) =>
  (twelve(locale) ? fmt(locale, "clock12", { hour: "numeric", minute: "2-digit" }) : fmt(locale, "clock24", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })).format(d);

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
export const fullStamp = (d: Date, locale?: string) => fmt(locale, "full", { dateStyle: "full", timeStyle: "short" }).format(d);
