import { describe, expect, it } from "vitest";
import { THEME_TOKENS, readTokens } from "./theme-tokens";

describe("readTokens", () => {
  it("reads the allowlisted tokens, trimmed, skipping empty ones", () => {
    const values: Record<string, string> = { "--background": " #101010 ", "--card": "#1c1c1c", "--secret": "x" };
    const out = readTokens((n) => values[n] ?? "");
    expect(out).toEqual({ background: "#101010", card: "#1c1c1c" });
  });
  it("covers the chrome's surfaces", () => {
    for (const t of ["background", "foreground", "card", "sidebar", "primary", "border", "ring", "destructive"]) expect(THEME_TOKENS).toContain(t);
    expect(THEME_TOKENS.length).toBeLessThanOrEqual(64);
  });
});
