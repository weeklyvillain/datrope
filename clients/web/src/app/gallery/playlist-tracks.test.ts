import type { PlaylistItem } from "@datrope/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../session", () => ({ client: { url: (p: string) => p, libraryAudioUrl: (id: string) => `/lib/${id}` }, useApp: () => undefined, displayName: () => "" }));

import { playableTracks } from "./playlist-tracks";

const item = (o: Partial<PlaylistItem>): PlaylistItem => ({ id: "i", title: "t", duration: 0, source: "link", ...o }) as PlaylistItem;

describe("playableTracks", () => {
  it("keeps files and uploads, in order, and leaves out links", () => {
    const got = playableTracks([
      item({ id: "1", title: "file", source: "file", attachment_id: "a1", channel_id: "c1" }),
      item({ id: "2", title: "yt", source: "link", url: "https://youtube.com/x" }),
      item({ id: "3", title: "up", source: "upload", track_id: "t1" }),
    ], (id) => (id === "c1" ? "music" : undefined));
    expect(got.map((t) => [t.title, t.subtitle])).toEqual([["file", "#music"], ["up", ""]]);
  });
});
