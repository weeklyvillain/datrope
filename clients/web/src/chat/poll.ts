// Pure poll helpers: results, ending, voting and the create form. No React.
import type { Poll, PollRequest } from "@datrope/core";

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 10;
export const MAX_QUESTION = 300;
export const MAX_OPTION = 55;

export type PollDuration = NonNullable<PollRequest["duration"]>;
export const DURATIONS: { value: PollDuration; label: string }[] = [
  { value: "1h", label: "1 hour" },
  { value: "4h", label: "4 hours" },
  { value: "8h", label: "8 hours" },
  { value: "24h", label: "24 hours" },
  { value: "3d", label: "3 days" },
  { value: "1w", label: "1 week" },
];

/** Each answer's share of the voters, in whole percent. Multiple-answer polls can add up to more than 100. */
export function percentages(poll: Pick<Poll, "options" | "total_voters">): number[] {
  const total = poll.total_voters;
  return (poll.options ?? []).map((o) => (total > 0 ? Math.round((o.count / total) * 100) : 0));
}

/** The positions with the most votes; none when nobody voted. */
export function winners(poll: Pick<Poll, "options">): number[] {
  const counts = (poll.options ?? []).map((o) => o.count);
  const top = Math.max(0, ...counts);
  return top === 0 ? [] : counts.flatMap((c, i) => (c === top ? [i] : []));
}

/** Over: ended on the server, or its end time has passed (checked locally, as the server does). */
export function isEnded(poll: Pick<Poll, "ended" | "ends_at">, now: number): boolean {
  return poll.ended || (!!poll.ends_at && Date.parse(poll.ends_at) <= now);
}

/** The time left until `endsAt`: "3d", "5h", "12m" or "<1m". */
export function timeLeft(endsAt: string, now: number): string {
  const minutes = Math.floor((Date.parse(endsAt) - now) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** "N votes · ends in 3h", "N votes · Final results", or "N votes" for a poll with no end. */
export function pollFooter(poll: Pick<Poll, "total_voters" | "ended" | "ends_at">, now: number): string {
  const votes = `${poll.total_voters} ${poll.total_voters === 1 ? "vote" : "votes"}`;
  if (isEnded(poll, now)) return `${votes} · Final results`;
  return poll.ends_at ? `${votes} · ends in ${timeLeft(poll.ends_at, now)}` : votes;
}

/** My votes after clicking answer `i`: a single answer switches (or clears), multiple answers toggle. */
export function nextVotes(poll: Pick<Poll, "multi" | "my_votes">, i: number): number[] {
  const mine = poll.my_votes ?? [];
  if (mine.includes(i)) return mine.filter((p) => p !== i);
  return poll.multi ? [...mine, i].sort((a, b) => a - b) : [i];
}

export type DraftOption = { key: string; text: string; emoji?: string };
export type PollDraft = { question: string; options: DraftOption[]; multi: boolean; anonymous: boolean; duration: PollDuration | "" };

/** The request for a draft, or what is missing. Blank answers are dropped; two must remain. */
export function buildPoll(d: PollDraft): PollRequest | { error: string } {
  const question = d.question.trim();
  if (!question) return { error: "Ask a question" };
  const options = d.options.flatMap((o) => {
    const text = o.text.trim();
    return text ? [{ text, ...(o.emoji ? { emoji: o.emoji } : {}) }] : [];
  });
  if (options.length < MIN_OPTIONS) return { error: "Add at least two answers" };
  return { question, options, multi: d.multi, anonymous: d.anonymous, ...(d.duration ? { duration: d.duration } : {}) };
}

/** Moves the item at `from` by `by` places; a move past either end changes nothing. */
export function move<T>(xs: T[], from: number, by: number): T[] {
  const to = from + by;
  if (to < 0 || to >= xs.length) return xs;
  const out = [...xs];
  [out[from], out[to]] = [out[to]!, out[from]!];
  return out;
}
