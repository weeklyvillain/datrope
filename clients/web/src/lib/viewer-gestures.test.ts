import { describe, expect, it } from "vitest";
import { pinchZoom, swipeIntent } from "./viewer-gestures";

describe("viewer gestures", () => {
  it("pinch scales with finger distance within 1–8", () => {
    expect(pinchZoom(1, 100, 200)).toBe(2);
    expect(pinchZoom(2, 100, 25)).toBe(1);
    expect(pinchZoom(4, 100, 400)).toBe(8);
  });
  it("horizontal swipes page, a downward swipe closes", () => {
    expect(swipeIntent(-80, 10)).toBe("next");
    expect(swipeIntent(80, -5)).toBe("prev");
    expect(swipeIntent(10, 120)).toBe("close");
    expect(swipeIntent(30, 20)).toBeNull();
    expect(swipeIntent(10, -150)).toBeNull();
  });
});
