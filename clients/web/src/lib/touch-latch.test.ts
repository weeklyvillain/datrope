import { afterEach, describe, expect, it, vi } from "vitest";
import { canLongPress, latch } from "./touch";

describe("latch", () => {
  it("stays false until opened, then stays true", () => {
    let v = false;
    v = latch(v, false);
    expect(v).toBe(false);
    v = latch(v, true);
    expect(v).toBe(true);
    v = latch(v, false);
    expect(v).toBe(true);
  });
});

describe("canLongPress", () => {
  afterEach(() => vi.unstubAllGlobals());
  const media = (coarse: string[]) => {
    const mm = (q: string) => ({ matches: coarse.includes(q) });
    vi.stubGlobal("window", { matchMedia: mm });
    vi.stubGlobal("matchMedia", mm);
  };
  it("is false without a window", () => expect(canLongPress()).toBe(false));
  it("is false with only a mouse", () => {
    media([]);
    expect(canLongPress()).toBe(false);
  });
  it("is true for a phone", () => {
    media(["(pointer: coarse)"]);
    expect(canLongPress()).toBe(true);
  });
  it("is true for a laptop with a touch screen", () => {
    media(["(any-pointer: coarse)"]);
    expect(canLongPress()).toBe(true);
  });
});
