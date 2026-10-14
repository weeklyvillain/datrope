import { describe, expect, it, vi } from "vitest";
import { createLayers, stripLayer } from "./history-layers";

/** `async`: back() lands later via deliver(), like a browser; otherwise it lands at once. */
function fakeHistory(async = false) {
  const stack: unknown[] = [null];
  let i = 0;
  let waiting = 0;
  const pop = vi.fn();
  const back = vi.fn(() => { if (async) waiting++; else if (i > 0) { i--; pop(stack[i]); } });
  return {
    stack, pop, back,
    deliver: () => { while (waiting > 0) { waiting--; if (i > 0) i--; } return stack[i]; },
    at: () => i,
    h: {
      push: (s: unknown) => { stack.splice(i + 1); stack.push(s); i++; },
      replace: (s: unknown) => { stack[i] = s; },
      back,
      current: () => stack[i],
    },
  };
}

describe("history layers", () => {
  it("back closes the top layer only", () => {
    const f = fakeHistory();
    const L = createLayers(f.h);
    const a = vi.fn(), b = vi.fn();
    L.open("a", a); L.open("b", b);
    f.h.back(); L.popped(f.h.current());
    expect(b).toHaveBeenCalledOnce(); expect(a).not.toHaveBeenCalled();
    expect(L.depth()).toBe(1);
  });
  it("closing from the UI goes back once and does not call onClose twice", () => {
    const f = fakeHistory();
    const L = createLayers(f.h);
    const a = vi.fn();
    L.open("a", a);
    L.close("a"); L.popped(f.h.current());
    expect(a).toHaveBeenCalledOnce(); expect(L.depth()).toBe(0);
  });
  it("a back that skips several entries closes all layers above it", () => {
    const f = fakeHistory();
    const L = createLayers(f.h);
    const a = vi.fn(), b = vi.fn();
    L.open("a", a); L.open("b", b);
    L.popped(null);
    expect(a).toHaveBeenCalledOnce(); expect(b).toHaveBeenCalledOnce();
  });
  it("closing a layer that is not on top closes it without navigating", () => {
    const f = fakeHistory();
    const L = createLayers(f.h);
    const a = vi.fn(), b = vi.fn();
    L.open("a", a); L.open("b", b);
    L.close("a");
    expect(a).toHaveBeenCalledOnce(); expect(L.depth()).toBe(1);
  });
  it("opening the same id twice keeps one entry", () => {
    const f = fakeHistory();
    const L = createLayers(f.h);
    L.open("a", vi.fn()); L.open("a", vi.fn());
    expect(L.depth()).toBe(1);
  });

  it("close then open before the pop: the open waits for the pop, a is closed, b has one entry", () => {
    for (const async of [false, true]) {
      const f = fakeHistory(async);
      const L = createLayers(f.h);
      const a = vi.fn(), b = vi.fn();
      L.open("a", a);
      L.close("a"); L.open("b", b);
      expect(a).toHaveBeenCalledOnce();
      expect(f.stack).toHaveLength(2); // b not pushed yet
      L.popped(async ? f.deliver() : f.h.current());
      expect(b).not.toHaveBeenCalled();
      expect(L.depth()).toBe(1);
      expect(f.stack).toHaveLength(2); // [null, b]
      expect(f.at()).toBe(1);
      f.h.back(); L.popped(async ? f.deliver() : f.h.current());
      expect(b).toHaveBeenCalledOnce();
    }
  });
  it("a pop arriving before the queued open flushes does not close the new layer", () => {
    const f = fakeHistory(true);
    const L = createLayers(f.h);
    L.open("a", vi.fn());
    L.close("a");
    L.popped(f.deliver()); // pop lands first
    const b = vi.fn();
    L.open("b", b);
    expect(L.depth()).toBe(1);
    expect(b).not.toHaveBeenCalled();
  });
  it("StrictMode: open, dispose, open, then the pop arrives: still open", () => {
    const f = fakeHistory(true);
    const L = createLayers(f.h);
    const a = vi.fn();
    L.open("a", a); L.dispose("a"); L.open("a", a);
    L.popped(f.deliver());
    expect(a).not.toHaveBeenCalled();
    expect(L.depth()).toBe(1);
    expect(L.isTop("a")).toBe(true);
  });
  it("dispose does not call onClose", () => {
    const f = fakeHistory();
    const L = createLayers(f.h);
    const a = vi.fn();
    L.open("a", a); L.dispose("a"); L.popped(f.h.current());
    expect(a).not.toHaveBeenCalled(); expect(L.depth()).toBe(0);
  });
  it("a router push over an open layer, then UI close: no back, stack empty", () => {
    const f = fakeHistory();
    const L = createLayers(f.h);
    const a = vi.fn();
    L.open("a", a);
    f.h.push({ idx: 2 }); // the router navigates
    expect(L.onTop()).toBe(false);
    L.close("a");
    expect(f.back).not.toHaveBeenCalled();
    expect(a).toHaveBeenCalledOnce(); expect(L.depth()).toBe(0);
  });
  it("a popped state lacking a middle layer closes only the missing ones", () => {
    const f = fakeHistory();
    const L = createLayers(f.h);
    const a = vi.fn(), b = vi.fn(), c = vi.fn();
    L.open("a", a); L.open("b", b); L.open("c", c);
    L.popped({ datropeLayer: { ids: ["a", "c"] } });
    expect(b).toHaveBeenCalledOnce(); expect(a).not.toHaveBeenCalled(); expect(c).not.toHaveBeenCalled();
    expect(L.depth()).toBe(2);
  });
  it("closing a lower layer while the top one stays leaves history alone", () => {
    const f = fakeHistory();
    const L = createLayers(f.h);
    L.open("a", vi.fn()); L.open("b", vi.fn());
    L.close("a");
    expect(f.back).not.toHaveBeenCalled();
    expect(L.isTop("b")).toBe(true);
  });
});

describe("stripLayer", () => {
  it("drops the layer record and keeps the router's keys", () => {
    expect(stripLayer({ datropeLayer: { ids: ["a"] }, idx: 3 })).toEqual({ idx: 3 });
  });
  it("leaves other states alone", () => {
    expect(stripLayer(null)).toBeNull();
    const s = { idx: 1 };
    expect(stripLayer(s)).toBe(s);
  });
});
