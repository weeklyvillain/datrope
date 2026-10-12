import type { Album } from "@datrope/core";
import { describe, expect, it, vi } from "vitest";

const { addToAlbum } = vi.hoisted(() => ({ addToAlbum: vi.fn() }));
vi.mock("../../session", () => ({ client: { addToAlbum }, errorText: (e: unknown) => String((e as Error).message ?? e) }));

import { addAll, groupAlbums } from "./albums";

const album = (id: string, role: Album["role"]): Album =>
  ({ id, title: id, visibility: "server", owner_id: "o", member_ids: [], item_count: 0, created_at: "", updated_at: "", role }) as Album;

describe("groupAlbums", () => {
  it("puts owned and collaborating albums under Yours and the rest under On the server, keeping order", () => {
    const got = groupAlbums([album("a", "viewer"), album("b", "owner"), album("c", "collaborator"), album("d", "viewer")]);
    expect(got.yours.map((a) => a.id)).toEqual(["b", "c"]);
    expect(got.server.map((a) => a.id)).toEqual(["a", "d"]);
  });
});

describe("addAll", () => {
  it("is empty when every file was added", async () => {
    addToAlbum.mockResolvedValue(undefined);
    expect(await addAll("a", ["1", "2"])).toBe("");
  });
  it("reports the reason for a single file", async () => {
    addToAlbum.mockRejectedValue(new Error("album full"));
    expect(await addAll("a", ["1"])).toBe("album full");
  });
  it("counts the failures of several files", async () => {
    addToAlbum.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("nope"));
    expect(await addAll("a", ["1", "2"])).toBe("1 of 2 files weren't added to the album: nope");
  });
});
