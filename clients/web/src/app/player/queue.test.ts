import { describe, expect, it } from "vitest";
import { advance, back, enqueue, moveTo, removeAt, shuffleUpcoming, start, type Track } from "./queue";

const t = (k: string): Track => ({ key: k, title: k, subtitle: "", src: `/${k}` });
const keys = (q: { tracks: Track[] }) => q.tracks.map((x) => x.key);

describe("player queue", () => {
  it("starts at the picked track", () => {
    expect(start([t("a"), t("b")], 1)).toEqual({ tracks: [t("a"), t("b")], index: 1 });
  });
  it("advances, wraps with repeat all, stops at the end otherwise", () => {
    const q = start([t("a"), t("b")], 1);
    expect(advance(q, "off")).toBeNull();
    expect(advance(q, "all")?.index).toBe(0);
    expect(advance(start([t("a"), t("b")], 0), "off")?.index).toBe(1);
  });
  it("repeat one replays the same track on a natural end", () => {
    expect(advance(start([t("a"), t("b")], 0), "one")?.index).toBe(0);
  });
  it("back goes to the previous track, not before the first", () => {
    expect(back(start([t("a"), t("b")], 1)).index).toBe(0);
    expect(back(start([t("a")], 0)).index).toBe(0);
  });
  it("enqueue appends; on an empty queue it starts", () => {
    expect(enqueue({ tracks: [], index: -1 }, [t("a")])).toEqual({ tracks: [t("a")], index: 0 });
    expect(keys(enqueue(start([t("a")], 0), [t("b")]))).toEqual(["a", "b"]);
  });
  it("enqueue skips keys already queued", () => {
    expect(keys(enqueue(start([t("a"), t("b")], 0), [t("b"), t("c")]))).toEqual(["a", "b", "c"]);
    expect(enqueue(start([t("a")], 0), [t("a")])).toEqual(start([t("a")], 0));
    expect(keys(enqueue({ tracks: [], index: -1 }, [t("a"), t("a")]))).toEqual(["a"]);
  });
  it("removing keeps the current track playing", () => {
    expect(removeAt(start([t("a"), t("b"), t("c")], 2), 0)).toEqual({ tracks: [t("b"), t("c")], index: 1 });
    expect(removeAt(start([t("a"), t("b")], 1), 1)).toEqual({ tracks: [t("a")], index: 0 });
    expect(removeAt(start([t("a")], 0), 0)).toEqual({ tracks: [], index: -1 });
  });
  it("moving follows the current track", () => {
    expect(moveTo(start([t("a"), t("b"), t("c")], 0), 0, 2)).toEqual({ tracks: [t("b"), t("c"), t("a")], index: 2 });
    expect(moveTo(start([t("a"), t("b"), t("c")], 1), 2, 0)).toEqual({ tracks: [t("c"), t("a"), t("b")], index: 2 });
  });
  it("shuffle keeps played tracks and the current one in place", () => {
    const q = shuffleUpcoming(start([t("a"), t("b"), t("c"), t("d")], 1), () => 0);
    expect(keys(q).slice(0, 2)).toEqual(["a", "b"]);
    expect(new Set(keys(q))).toEqual(new Set(["a", "b", "c", "d"]));
  });
});
