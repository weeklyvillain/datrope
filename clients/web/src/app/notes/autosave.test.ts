import { ApiError } from "@datrope/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./notes-store", () => ({ saveNote: vi.fn(), setDirty: vi.fn() }));

import { createSaver, noteSaver, type SaveStatus } from "./autosave";

describe("createSaver", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const setup = (save = vi.fn().mockResolvedValue(undefined)) => {
    const statuses: SaveStatus[] = [];
    const dirty = vi.fn();
    const s = createSaver({ delay: 800, save, onStatus: (x) => statuses.push(x), onDirty: dirty });
    return { s, save, statuses, dirty };
  };

  it("debounces and merges edits into one save", async () => {
    const { s, save, dirty } = setup();
    s.edit("1", { title: "a" });
    s.edit("1", { content: { type: "doc" }, text: "x" });
    expect(dirty).toHaveBeenCalledWith("1", true);
    await vi.advanceTimersByTimeAsync(799);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("1", { title: "a", content: { type: "doc" }, text: "x" });
    expect(dirty).toHaveBeenLastCalledWith("1", false);
  });

  it("flush on switch: editing another note saves the first one right away to its own id", async () => {
    const { s, save } = setup();
    s.edit("1", { title: "a" });
    s.edit("2", { title: "b" });
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenNthCalledWith(1, "1", { title: "a" });
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenNthCalledWith(2, "2", { title: "b" });
  });

  it("keeps edits made during a save dirty and saves them next", async () => {
    let finish!: () => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>((r) => { finish = r; })).mockResolvedValue(undefined);
    const { s, dirty } = setup(save);
    s.edit("1", { title: "a" });
    await vi.advanceTimersByTimeAsync(800);
    s.edit("1", { title: "ab" });
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(dirty).not.toHaveBeenLastCalledWith("1", false);
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenLastCalledWith("1", { title: "ab" });
  });

  it("reports an error and retries the same patch", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValue(undefined);
    const { s, statuses } = setup(save);
    s.edit("1", { title: "a" });
    await vi.advanceTimersByTimeAsync(800);
    expect(statuses.at(-1)).toBe("error");
    await s.retry();
    expect(save).toHaveBeenLastCalledWith("1", { title: "a" });
    expect(statuses.at(-1)).toBe("saved");
  });

  it("404 stops: a deleted note's edits are dropped, not retried", async () => {
    const save = vi.fn().mockRejectedValue(new ApiError(404, "NOT_FOUND", "note not found"));
    const { s, statuses } = setup(save);
    s.edit("1", { title: "a" });
    await vi.advanceTimersByTimeAsync(800);
    expect(statuses.at(-1)).toBe("deleted");
    await s.retry();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("says whether edits are waiting, for the leave-page warning", async () => {
    const { s } = setup();
    expect(s.pending()).toBe(false);
    s.edit("1", { title: "a" });
    expect(s.pending()).toBe(true);
    await vi.advanceTimersByTimeAsync(800);
    expect(s.pending()).toBe(false);
  });

  it("keeps a failed save queued, and saves it before the next note's", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const { s } = setup(save);
    s.edit("1", { title: "a" });
    await s.flush();
    expect(s.pending()).toBe(true);
    s.edit("2", { title: "b" });
    await vi.advanceTimersByTimeAsync(800);
    expect(save.mock.calls.map((c) => c[0])).toEqual(["1", "1", "2"]);
  });
});

describe("noteSaver", () => {
  it("is one saver for the app, so a note's queued edits outlive its view", () => {
    expect(noteSaver()).toBe(noteSaver());
  });
});
