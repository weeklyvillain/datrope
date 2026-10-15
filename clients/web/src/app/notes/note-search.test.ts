import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../session", () => ({ errorText: (e: unknown) => (e as Error).message }));

import { createNoteSearch, type SearchState } from "./note-search";

describe("createNoteSearch", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const setup = () => {
    const pending: { q: string; resolve: (r: string[]) => void; reject: (e: Error) => void }[] = [];
    const list = vi.fn((q: string) => new Promise<string[]>((resolve, reject) => pending.push({ q, resolve, reject })));
    const states: SearchState<string>[] = [];
    const search = createNoteSearch({ list, delay: 250, onChange: (s) => states.push(s) });
    return { search, list, pending, last: () => states.at(-1)! };
  };

  it("searches once the typing pauses", async () => {
    const { search, list, pending, last } = setup();
    search.set("ra");
    search.set("raid");
    await vi.advanceTimersByTimeAsync(250);
    expect(list.mock.calls).toEqual([["raid"]]);
    pending[0].resolve(["Raid roster"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toEqual({ found: ["Raid roster"], error: "" });
  });

  it("drops a response that arrives after the box was cleared", async () => {
    const { search, pending, last } = setup();
    search.set("raid");
    await vi.advanceTimersByTimeAsync(250);
    search.set("");
    pending[0].resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toEqual({ found: null, error: "" });
  });

  it("drops an older query's response that arrives last", async () => {
    const { search, pending, last } = setup();
    search.set("a");
    await vi.advanceTimersByTimeAsync(250);
    search.set("ab");
    await vi.advanceTimersByTimeAsync(250);
    pending[1].resolve(["ab"]);
    pending[0].resolve(["a"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(last().found).toEqual(["ab"]);
  });

  it("shows an error, and clears it on the next search", async () => {
    const { search, pending, last } = setup();
    search.set("x");
    await vi.advanceTimersByTimeAsync(250);
    pending[0].reject(new Error("offline"));
    await vi.advanceTimersByTimeAsync(0);
    expect(last().error).toBe("offline");
    search.set("xy");
    expect(last().error).toBe("");
  });

  it("refresh repeats the current query (the list changed)", async () => {
    const { search, list } = setup();
    search.set("raid");
    await vi.advanceTimersByTimeAsync(250);
    search.refresh();
    await vi.advanceTimersByTimeAsync(250);
    expect(list).toHaveBeenLastCalledWith("raid");
    expect(list).toHaveBeenCalledTimes(2);
  });
});
