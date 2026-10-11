import { describe, expect, it } from "vitest";
import { retryDelay } from "./retry";

describe("retryDelay", () => {
  it("backs off from 5 s to 40 s, then retries every minute", () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(retryDelay)).toEqual([5, 10, 20, 40, 60, 60, 60]);
  });
});
