/** A time someone wrote in a message ("9pm", "21:00 CET"), found in plain text. */
export interface TimeMatch {
  index: number;
  length: number;
  hour: number; // 0-23
  minute: number;
  zone?: string; // as written: "CET", "UTC+2", ...
}

const ABBR: Record<string, number> = {
  UTC: 0, GMT: 0, WET: 0, WEST: 60, BST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180,
  EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420,
};
const ZONE = String.raw`(?:(?:UTC|GMT)[+-]\d{1,2}(?::?\d{2})?|${Object.keys(ABBR).join("|")})`;
// 12-hour: 1-12 with optional :mm or .mm, then am/pm. 24-hour: H:MM or HH:MM with a colon.
// Not inside a word or a longer number ("v1.2.3", "10:30:15", "a9pm").
const TIME = new RegExp(
  String.raw`(?<![\w:.])(?:(1[0-2]|0?[1-9])(?:[:.]([0-5]\d))?\s?([aApP])\.?[mM]\.?|([01]?\d|2[0-3]):([0-5]\d))(?![\w:]|\.\d)(?:\s(${ZONE})(?![\w+-]))?`,
  "g",
);

export function findTimes(text: string): TimeMatch[] {
  const out: TimeMatch[] = [];
  for (const m of text.matchAll(TIME)) {
    const zone = m[6] || undefined;
    if (m[3]) {
      const h = Number(m[1]) % 12 + (m[3].toLowerCase() === "p" ? 12 : 0);
      out.push({ index: m.index, length: m[0].length, hour: h, minute: Number(m[2] ?? 0), zone });
    } else {
      out.push({ index: m.index, length: m[0].length, hour: Number(m[4]), minute: Number(m[5]), zone });
    }
  }
  return out;
}

const parts = new Map<string, Intl.DateTimeFormat>();
function partsIn(tz: string): Intl.DateTimeFormat | null {
  let f = parts.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    } catch {
      return null;
    }
    parts.set(tz, f);
  }
  return f;
}

/** The calendar date and wall time in `tz` at `utcMs`. */
function wall(tz: string, utcMs: number) {
  const f = partsIn(tz);
  if (!f) return null;
  const p = Object.fromEntries(f.formatToParts(utcMs).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute };
}

/** Minutes east of UTC for `zone` at `atUtcMs`: an IANA name (with DST), an abbreviation or UTC±H[:MM]. */
export function zoneOffsetMinutes(zone: string, atUtcMs: number): number | null {
  const up = zone.toUpperCase();
  if (up in ABBR) return ABBR[up]!;
  const fixed = /^(?:UTC|GMT)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(up);
  if (fixed) {
    const sign = fixed[1] === "-" ? -1 : 1;
    const h = Number(fixed[2]);
    const m = Number(fixed[3] ?? 0);
    if (m > 59 || (sign < 0 ? h > 12 : h > 14) || (h === 14 && m > 0 && sign > 0) || (h === 12 && m > 0 && sign < 0)) return null;
    return sign * (h * 60 + m);
  }
  const w = wall(zone, atUtcMs);
  if (!w) return null;
  return Math.round((Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(atUtcMs / 60000) * 60000) / 60000);
}

/** The instant a written time means: that wall time on the sender's calendar date, in the written zone or the sender's. */
export function resolveTime(t: TimeMatch, sentAtIso: string, senderTz?: string): Date | null {
  const zone = t.zone ?? senderTz;
  if (!zone) return null;
  const sent = Date.parse(sentAtIso);
  if (Number.isNaN(sent)) return null;
  const day = wall(senderTz ?? "UTC", sent) ?? wall("UTC", sent)!;
  const guess = Date.UTC(day.y, day.mo - 1, day.d, t.hour, t.minute);
  const first = zoneOffsetMinutes(zone, guess);
  if (first === null) return null;
  // Twice, so a DST change between the guess and the answer settles on the right offset.
  const second = zoneOffsetMinutes(zone, guess - first * 60000) ?? first;
  return new Date(guess - second * 60000);
}

/** The calendar day number (days since 1970) in `zone` at `ms`; null for an unknown zone. */
function dayIn(zone: string, ms: number): number | null {
  const off = zoneOffsetMinutes(zone, ms);
  return off === null ? null : Math.floor((ms + off * 60000) / 86400000);
}

/** How many days the reader's date is ahead of the source zone's date at `atIso`: -1, 0 or +1 (for a "+1d" marker). */
export function dayShift(atIso: string, sourceZone: string, readerZone: string): number {
  const ms = Date.parse(atIso);
  if (Number.isNaN(ms)) return 0;
  const a = dayIn(readerZone, ms);
  const b = dayIn(sourceZone, ms);
  return a === null || b === null ? 0 : a - b;
}
