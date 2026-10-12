import { describe, expect, it } from "vitest";
import { DEFAULT_FILTER, filterParams, parseFilter } from "./filter";

describe("gallery filter params", () => {
  it("round-trips every field except layout", () => {
    const f = { ...DEFAULT_FILTER, kind: "audio" as const, channels: ["1", "2"], uploader: "9", q: "riff", view: "playlists" as const, playlist: "7" };
    expect(parseFilter(filterParams(f))).toEqual(f);
  });
  it("omits defaults", () => {
    expect(filterParams(DEFAULT_FILTER).toString()).toBe("");
  });
  it("ignores unknown kinds and views", () => {
    expect(parseFilter(new URLSearchParams("kind=music&view=x"))).toEqual(DEFAULT_FILTER);
  });
});
