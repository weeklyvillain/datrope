import { beforeEach, describe, expect, it } from "vitest";
import { isCollapsed, setCollapsed } from "./collapsed";

// Vitest runs in Node (no jsdom here): a tiny in-memory localStorage.
const data = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => void data.set(k, String(v)),
  removeItem: (k: string) => void data.delete(k),
  clear: () => data.clear(),
  key: (i: number) => [...data.keys()][i] ?? null,
  get length() {
    return data.size;
  },
} as Storage;

describe("collapsed categories", () => {
  beforeEach(() => localStorage.clear());

  it("remembers per category", () => {
    expect(isCollapsed("1")).toBe(false);
    setCollapsed("1", true);
    expect(isCollapsed("1")).toBe(true);
    expect(JSON.parse(localStorage.getItem("datrope.collapsedCategories")!)).toEqual(["1"]);
    setCollapsed("1", false);
    expect(isCollapsed("1")).toBe(false);
  });

  it("survives a broken store", () => {
    localStorage.setItem("datrope.collapsedCategories", "{not json");
    expect(isCollapsed("1")).toBe(false);
    setCollapsed("2", true);
    expect(isCollapsed("2")).toBe(true);
  });
});
