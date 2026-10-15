import { describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

describe("copyText", () => {
  it("uses the Clipboard API when there is one", async () => {
    const writeText = vi.fn(async () => {});
    expect(await copyText("hi", { clipboard: { writeText }, fallback: () => false })).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hi");
  });
  it("falls back when the API is missing", async () => {
    const fallback = vi.fn(() => true);
    expect(await copyText("hi", { clipboard: undefined, fallback })).toBe(true);
    expect(fallback).toHaveBeenCalledWith("hi");
  });
  it("falls back when the API rejects", async () => {
    const fallback = vi.fn(() => true);
    expect(await copyText("hi", { clipboard: { writeText: async () => { throw new Error("denied"); } }, fallback })).toBe(true);
  });
  it("reports failure when both fail", async () =>
    expect(await copyText("hi", { clipboard: undefined, fallback: () => false })).toBe(false));
});
