import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPing, estimateToYou, freshPing, startPingSender } from "./pings";

describe("pings", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("estimates the round trip to a peer as both pings", () => {
    expect(estimateToYou(40, 45)).toBe(85);
    expect(estimateToYou(undefined, 45)).toBeUndefined();
  });
  it("forgets pings older than 15 s", () => {
    const byUser = applyPing({}, { user_id: "1", rtt_ms: 42 }, 1000);
    expect(freshPing(byUser, "1", 1000 + 14_000)).toBe(42);
    expect(freshPing(byUser, "1", 1000 + 16_000)).toBeUndefined();
  });
  it("sends my rounded ping every 5 s while known, and stops", () => {
    const send = vi.fn(async () => {});
    let rtt: number | undefined = undefined;
    const stop = startPingSender(() => rtt, send);
    vi.advanceTimersByTime(5000);
    expect(send).not.toHaveBeenCalled(); // not measured yet
    rtt = 41.6;
    vi.advanceTimersByTime(5000);
    expect(send).toHaveBeenCalledWith(42);
    stop();
    vi.advanceTimersByTime(20_000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
