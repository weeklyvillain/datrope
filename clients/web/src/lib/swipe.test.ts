import { describe, expect, it } from "vitest";
import { createSwipe } from "./swipe";

describe("swipe to reply", () => {
  it("locks to x and triggers past 64px", () => {
    const s = createSwipe(); s.down(0, 0);
    expect(s.move(12, 2)).toEqual({ dx: 12, axis: "x" });
    expect(s.move(70, 4).dx).toBe(70);
    expect(s.up()).toBe(true);
  });
  it("does not trigger below the threshold", () => {
    const s = createSwipe(); s.down(0, 0); s.move(40, 0); expect(s.up()).toBe(false);
  });
  it("a vertical start never becomes a swipe", () => {
    const s = createSwipe(); s.down(0, 0);
    expect(s.move(2, 12).axis).toBe("y");
    expect(s.move(90, 14)).toEqual({ dx: 0, axis: "y" });
    expect(s.up()).toBe(false);
  });
  it("small drift is undecided (a tap)", () => {
    const s = createSwipe(); s.down(0, 0);
    expect(s.move(5, 3)).toEqual({ dx: 0, axis: null });
    expect(s.up()).toBe(false);
  });
  it("leftward and over-max drags are clamped", () => {
    const s = createSwipe(); s.down(0, 0); s.move(12, 0);
    expect(s.move(-30, 0).dx).toBe(0);
    expect(s.move(300, 0).dx).toBe(96);
  });
});
