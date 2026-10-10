import { describe, expect, it } from "vitest";
import { addedSummary, formatBytes, linkKind, totalLength } from "./music";

describe("linkKind", () => {
  it.each([
    ["https://www.youtube.com/playlist?list=PL1", "list"],
    ["https://music.youtube.com/playlist?list=PL1", "list"],
    ["https://www.youtube.com/watch?v=abc&list=PL1", "track-in-list"],
    ["https://youtu.be/abc?list=PL1", "track-in-list"],
    ["https://www.youtube.com/watch?v=abc", undefined],
    ["https://soundcloud.com/band/sets/live", "list"],
    ["https://soundcloud.com/band/song", undefined],
    ["https://band.bandcamp.com/album/first", "list"],
    ["https://band.bandcamp.com/track/one", undefined],
    ["https://open.spotify.com/playlist/37i9", "list"],
    ["https://open.spotify.com/intl-sv/album/1A2", "list"],
    ["https://open.spotify.com/track/1A2", undefined],
    ["never gonna give you up", undefined],
    ["ftp://youtube.com/playlist?list=x", undefined],
  ])("%s → %s", (input, kind) => {
    expect(linkKind(input)).toBe(kind);
  });
});

describe("formatting", () => {
  it("sizes and lengths", () => {
    expect(formatBytes(512 * 1024)).toBe("512 KB");
    expect(formatBytes(4.25 * 1024 * 1024)).toBe("4.3 MB");
    expect(formatBytes(300 * 1024 * 1024)).toBe("300 MB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
    expect(totalLength(45)).toBe("45 s");
    expect(totalLength(12 * 60 + 20)).toBe("12 min");
    expect(totalLength(3900)).toBe("1 h 5 min");
  });

  it("summarises only several tracks or problems", () => {
    expect(addedSummary("Queued", { count: 1, skipped: 0, dropped: 0 })).toBeUndefined();
    expect(addedSummary("Queued", { count: 412, skipped: 88, dropped: 0 })).toBe("Queued 412 tracks, 88 didn't fit.");
    expect(addedSummary("Added", { count: 3, skipped: 0, dropped: 1 })).toBe("Added 3 tracks, 1 unavailable track was left out.");
  });
});
