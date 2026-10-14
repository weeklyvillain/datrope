import { describe, expect, it, vi } from "vitest";

const { addToAlbum } = vi.hoisted(() => ({ addToAlbum: vi.fn() }));
vi.mock("../../session", () => ({ client: { addToAlbum }, errorText: (e: unknown) => String((e as Error).message ?? e) }));

import { addAll } from "./albums";

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
