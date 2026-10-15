import { describe, expect, it } from "vitest";
import { contrast } from "@/lib/color";
import { activeVars, MAX_CUSTOM_THEMES, removeCustomTheme, resolveTheme, sanitizeList, saveCustomTheme } from "./custom";

const t = { id: "a", name: "Ocean night", seed: "#1a237e", ownAccent: false };

describe("custom themes", () => {
  it("keeps valid entries and normalizes them", () => {
    expect(sanitizeList([{ ...t, name: "  Ocean night ", seed: "#1A237E" }])).toEqual([t]);
  });

  it("drops bad entries, duplicates and overflow", () => {
    const bad = [null, 3, { ...t, id: "" }, { ...t, id: "b", name: "  " }, { ...t, id: "c", seed: "blue" }, t, { ...t, name: "dup" }];
    expect(sanitizeList(bad)).toEqual([t]);
    expect(sanitizeList("nope")).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => ({ ...t, id: `x${i}` }));
    expect(sanitizeList(many)).toHaveLength(MAX_CUSTOM_THEMES);
    expect(sanitizeList([{ ...t, name: "x".repeat(40) }])[0]!.name).toHaveLength(32);
  });

  it("resolves the active theme", () => {
    expect(resolveTheme("datrope", [t])).toEqual({ ownsAccent: false });
    expect(resolveTheme("gotham", [t]).ownsAccent).toBe(true);
    const custom = resolveTheme("custom:a", [t]);
    expect(custom.ownsAccent).toBe(false);
    expect(custom.vars?.["--primary"]).toBeUndefined();
    expect(custom.surfaces).toEqual([custom.vars!["--background"], custom.vars!["--sidebar"], custom.vars!["--card"]]);
    expect(resolveTheme("custom:a", [{ ...t, ownAccent: true }]).ownsAccent).toBe(true);
  });

  it("falls back to the default for a deleted custom theme", () => {
    expect(resolveTheme("custom:gone", [t])).toEqual({ ownsAccent: false });
  });
});

describe("activeVars", () => {
  const server = "#445ab8";

  it("keeps an owning theme's accent tokens even when they equal the server accent's", () => {
    // Review finding: AWA's label is #ffffff, as is the server accent's; the accent must not touch it.
    const v = activeVars(resolveTheme("awa", []), server, true);
    expect(v["--primary"]).toBe("#444444");
    expect(v["--primary-foreground"]).toBe("#ffffff");
  });

  it("uses a custom theme's own accent", () => {
    const v = activeVars(resolveTheme("custom:a", [{ ...t, seed: "#4aa3ff", ownAccent: true }]), "#4aa3ff", true);
    expect(v["--primary"]).toBe("#4aa3ff");
    expect(v["--background"]).toBeDefined();
  });

  it("fits the server accent to a custom theme's surfaces", () => {
    const theme = resolveTheme("custom:a", [t]);
    const v = activeVars(theme, server, true);
    for (const s of theme.surfaces!) expect(contrast(v["--primary"]!, s)).toBeGreaterThanOrEqual(4.5);
    expect(v["--ring"]).toBe(v["--primary"]);
  });

  it("applies only the accent outside the app shell, and nothing when my theme owns it", () => {
    expect(Object.keys(activeVars(resolveTheme("datrope", []), server, false)).sort()).toEqual(["--primary", "--primary-foreground", "--ring"]);
    expect(activeVars(resolveTheme("gotham", []), server, false)).toEqual({});
    expect(activeVars(resolveTheme("datrope", []), undefined, true)).toEqual({});
  });
});

describe("saveCustomTheme", () => {
  it("says whether it saved, and refuses past the limit", () => {
    for (let i = 0; i < MAX_CUSTOM_THEMES; i++) expect(saveCustomTheme({ ...t, id: `s${i}` })).toBe(true);
    expect(saveCustomTheme({ ...t, id: "one-too-many" })).toBe(false);
    expect(saveCustomTheme({ ...t, id: "s0", name: "Renamed" })).toBe(true); // editing still works when full
    for (let i = 0; i < MAX_CUSTOM_THEMES; i++) removeCustomTheme(`s${i}`);
  });
});
