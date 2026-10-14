import { describe, expect, it } from "vitest";
import { parseThemeFragment, safeTheme } from "./theme";

const supports = (v: string) => /^(#[0-9a-f]{3,8}|rgb\(.*\))$/i.test(v);

describe("safeTheme", () => {
  it("keeps allowlisted tokens with colour values", () => {
    expect(safeTheme({ background: "#111", card: "rgb(1,2,3)" }, supports)).toEqual({ background: "#111", card: "rgb(1,2,3)" });
  });
  it("drops unknown names, non-colours and non-strings", () => {
    expect(safeTheme({ background: "#111", evil: "#fff", card: "red", ring: 5 }, supports)).toEqual({ background: "#111" });
  });
  it("returns nothing for non-objects", () => {
    expect(safeTheme(null, supports)).toEqual({});
    expect(safeTheme("x", supports)).toEqual({});
  });
});

describe("parseThemeFragment", () => {
  it("decodes #theme=", () => {
    const hash = `#theme=${encodeURIComponent(JSON.stringify({ background: "#111" }))}`;
    expect(parseThemeFragment(hash, supports)).toEqual({ background: "#111" });
  });
  it("ignores bad input", () => {
    expect(parseThemeFragment("", supports)).toEqual({});
    expect(parseThemeFragment("#theme=%7Bnope", supports)).toEqual({});
    expect(parseThemeFragment("#other=1", supports)).toEqual({});
  });
});
