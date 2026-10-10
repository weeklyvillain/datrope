import { describe, expect, it } from "vitest";
import { buildPoll, isEnded, move, nextVotes, percentages, pollFooter, timeLeft, winners } from "./poll";

const opts = (...counts: number[]) => counts.map((count, i) => ({ text: `o${i}`, count }));
const NOW = Date.parse("2026-10-10T12:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe("percentages", () => {
  it("is each answer's share of the voters, rounded", () => {
    expect(percentages({ options: opts(1, 2), total_voters: 3 })).toEqual([33, 67]);
  });
  it("can add up to more than 100 with multiple answers", () => {
    expect(percentages({ options: opts(2, 2, 1), total_voters: 2 })).toEqual([100, 100, 50]);
  });
  it("is 0 without votes", () => {
    expect(percentages({ options: opts(0, 0), total_voters: 0 })).toEqual([0, 0]);
  });
});

describe("winners", () => {
  it.each([
    [[3, 1, 2], [0]],
    [[2, 2, 1], [0, 1]],
    [[0, 0], []],
  ])("%j → %j", (counts, want) => {
    expect(winners({ options: opts(...counts) })).toEqual(want);
  });
});

describe("ending", () => {
  it("ends early, at ends_at, or never", () => {
    expect(isEnded({ ended: true }, NOW)).toBe(true);
    expect(isEnded({ ended: false, ends_at: at(1000) }, NOW)).toBe(false);
    expect(isEnded({ ended: false, ends_at: at(0) }, NOW)).toBe(true);
    expect(isEnded({ ended: false }, NOW)).toBe(false);
  });

  it.each([
    [30_000, "<1m"],
    [45 * 60_000, "45m"],
    [3 * 3_600_000 + 5 * 60_000, "3h"],
    [23 * 3_600_000 + 59 * 60_000, "23h"],
    [3 * 86_400_000, "3d"],
  ])("%d ms left reads %s", (ms, want) => {
    expect(timeLeft(at(ms), NOW)).toBe(want);
  });

  it("writes the footer", () => {
    expect(pollFooter({ total_voters: 1, ended: false, ends_at: at(3 * 3_600_000) }, NOW)).toBe("1 vote · ends in 3h");
    expect(pollFooter({ total_voters: 2, ended: false }, NOW)).toBe("2 votes");
    expect(pollFooter({ total_voters: 0, ended: false, ends_at: at(-1) }, NOW)).toBe("0 votes · Final results");
    expect(pollFooter({ total_voters: 5, ended: true }, NOW)).toBe("5 votes · Final results");
  });
});

describe("nextVotes", () => {
  it("switches or clears a single answer", () => {
    expect(nextVotes({ multi: false, my_votes: [] }, 1)).toEqual([1]);
    expect(nextVotes({ multi: false, my_votes: [0] }, 1)).toEqual([1]);
    expect(nextVotes({ multi: false, my_votes: [1] }, 1)).toEqual([]);
  });
  it("toggles multiple answers, sorted", () => {
    expect(nextVotes({ multi: true, my_votes: [2] }, 0)).toEqual([0, 2]);
    expect(nextVotes({ multi: true, my_votes: [0, 2] }, 2)).toEqual([0]);
    expect(nextVotes({ multi: true, my_votes: null }, 1)).toEqual([1]);
  });
});

describe("buildPoll", () => {
  const draft = {
    question: "  Pizza?  ",
    options: [{ key: "a", text: " Yes ", emoji: "🍕" }, { key: "b", text: "  " }, { key: "c", text: "No" }],
    multi: true, anonymous: false, duration: "24h" as const,
  };
  it("trims, drops blank answers and keeps the settings", () => {
    expect(buildPoll(draft)).toEqual({
      question: "Pizza?", options: [{ text: "Yes", emoji: "🍕" }, { text: "No" }], multi: true, anonymous: false, duration: "24h",
    });
  });
  it("leaves the duration out for a poll with no end", () => {
    expect(buildPoll({ ...draft, duration: "" })).not.toHaveProperty("duration");
  });
  it("needs a question and two answers", () => {
    expect(buildPoll({ ...draft, question: " " })).toEqual({ error: "Ask a question" });
    expect(buildPoll({ ...draft, options: draft.options.slice(0, 2) })).toEqual({ error: "Add at least two answers" });
  });
});

describe("move", () => {
  it("moves an item up or down, and not past the ends", () => {
    expect(move(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(move(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(move(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });
});
