import { describe, expect, it, vi } from "vitest";
import { claimEvent, createLongPress } from "./long-press";

function timers() {
  let fn: (() => void) | null = null;
  return { schedule: (f: () => void) => { fn = f; return 1; }, cancel: () => { fn = null; }, fire: () => fn?.() };
}

describe("long press", () => {
  it("fires after the delay and reports it on up", () => {
    const t = timers(); const on = vi.fn();
    const lp = createLongPress({ onLongPress: on, schedule: t.schedule, cancel: t.cancel });
    lp.down(10, 10); t.fire();
    expect(on).toHaveBeenCalledOnce(); expect(lp.up()).toBe(true);
  });
  it("tolerates a small drift (tap that moves 6px)", () => {
    const t = timers(); const on = vi.fn();
    const lp = createLongPress({ onLongPress: on, schedule: t.schedule, cancel: t.cancel });
    lp.down(10, 10); lp.move(14, 14); t.fire();
    expect(on).toHaveBeenCalledOnce();
  });
  it("cancels on a move over 8px (scrolling)", () => {
    const t = timers(); const on = vi.fn();
    const lp = createLongPress({ onLongPress: on, schedule: t.schedule, cancel: t.cancel });
    lp.down(10, 10); lp.move(10, 30); t.fire();
    expect(on).not.toHaveBeenCalled(); expect(lp.up()).toBe(false);
  });
  it("a quick tap does not fire", () => {
    const t = timers(); const on = vi.fn();
    const lp = createLongPress({ onLongPress: on, schedule: t.schedule, cancel: t.cancel });
    lp.down(0, 0); expect(lp.up()).toBe(false); t.fire();
    expect(on).not.toHaveBeenCalled();
  });
  it("fire() while pending fires once; the timer does not double-fire", () => {
    const t = timers(); const on = vi.fn();
    const lp = createLongPress({ onLongPress: on, schedule: t.schedule, cancel: t.cancel });
    lp.down(0, 0);
    expect(lp.fire()).toBe(true); t.fire();
    expect(on).toHaveBeenCalledOnce(); expect(lp.fire()).toBe(false); expect(lp.up()).toBe(true);
  });
  it("fire() with nothing pending is a no-op", () => {
    const t = timers(); const on = vi.fn();
    const lp = createLongPress({ onLongPress: on, schedule: t.schedule, cancel: t.cancel });
    expect(lp.fire()).toBe(false); expect(on).not.toHaveBeenCalled();
  });
});

describe("claimEvent", () => {
  it("only the first claimant wins", () => {
    const set = new WeakSet<object>(); const ev = {};
    expect(claimEvent(set, ev)).toBe(true); expect(claimEvent(set, ev)).toBe(false);
    expect(claimEvent(set, {})).toBe(true);
  });
});
