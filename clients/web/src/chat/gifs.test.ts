import { ApiError } from "@datrope/core";
import { describe, expect, it } from "vitest";
import { appendUnique, attachError, masonry, requestTickets } from "./gifs";

const g = (id: string, width = 100, height = 100) => ({ id, width, height });
const names = (cols: { id: string }[][]) => cols.map((c) => c.map((x) => x.id));

describe("masonry", () => {
  it("puts each GIF in the shortest column, keeping order within a column", () => {
    expect(names(masonry([g("a", 100, 200), g("b"), g("c"), g("d", 100, 50)], 2))).toEqual([["a", "d"], ["b", "c"]]);
  });

  it("treats a GIF of unknown size as square", () => {
    expect(names(masonry([g("z", 0, 0), g("y"), g("x")], 2))).toEqual([["z", "x"], ["y"]]);
  });

  it("returns empty columns for no GIFs", () => {
    expect(masonry([], 3)).toEqual([[], [], []]);
  });
});

describe("appendUnique", () => {
  it("skips GIFs already listed (Klipy pages can overlap)", () => {
    expect(appendUnique([g("a"), g("b")], [g("b"), g("c")]).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});

describe("requestTickets", () => {
  it("lets only the newest request through", () => {
    const t = requestTickets();
    const first = t.renew();
    const second = t.renew(); // the user typed more
    expect(t.isNewest(first)).toBe(false);
    expect(t.isNewest(second)).toBe(true);
    const more = t.current(); // the next page of the same search
    expect(t.isNewest(more)).toBe(true);
    t.renew(); // a new search starts while that page loads
    expect(t.isNewest(more)).toBe(false);
  });
});

describe("attachError", () => {
  it.each([
    [new ApiError(413, "TOO_LARGE", "files can be at most 8388608 bytes"), "That GIF is too big to post here. Try another one."],
    [new ApiError(429, "RATE_LIMITED", "too many requests, slow down"), "You're sending GIFs too fast. Wait a moment and try again."],
    [new ApiError(502, "GIF_PROVIDER_ERROR", "couldn't reach Klipy, try again"), "Couldn't reach Klipy. Try again."],
    [new ApiError(403, "MISSING_PERMISSION", "you do not have permission to do that"), "you do not have permission to do that"],
    [new Error("boom"), "Something went wrong. Please try again."],
  ])("%s", (e, want) => {
    expect(attachError(e)).toBe(want);
  });
});
