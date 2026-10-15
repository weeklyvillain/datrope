import { describe, expect, it } from "vitest";
import {
  contrast, deriveTheme, fromHsv, fromOklch, isHex, labelOn, normalizeHex, readableAccent, SURFACE_TOKENS, toHsv, toOklch,
} from "./color";
import { PALETTES } from "./palettes";

const seeds = (() => {
  const out = ["#000000", "#ffffff", "#808080", "#1a237e", "#fff59d", "#c0392b"];
  for (let h = 0; h < 360; h += 15)
    for (const l of [0.05, 0.3, 0.6, 0.95]) for (const c of [0, 0.1, 0.3]) out.push(fromOklch({ l, c, h }));
  return out;
})();

describe("hex", () => {
  it("validates and normalizes", () => {
    expect(isHex("#a1b2c3")).toBe(true);
    expect(isHex("a1b2c3")).toBe(false);
    expect(normalizeHex("A1B2C3")).toBe("#a1b2c3");
    expect(normalizeHex(" #A1B2C3 ")).toBe("#a1b2c3");
    expect(normalizeHex("#abc")).toBeUndefined();
    expect(normalizeHex("zzzzzz")).toBeUndefined();
  });
});

describe("conversions", () => {
  it("round-trips OKLCH and HSV", () => {
    for (const hex of ["#2ecc71", "#4aa3ff", "#131313", "#ffffff", "#000000", "#ff00ff", "#1a237e"]) {
      expect(fromOklch(toOklch(hex))).toBe(hex);
      expect(fromHsv(toHsv(hex))).toBe(hex);
    }
  });

  it("keeps hue when bringing a color into gamut", () => {
    const out = toOklch(fromOklch({ l: 0.9, c: 0.4, h: 260 }));
    expect(Math.abs(out.h - 260)).toBeLessThan(3);
  });

  it("gives achromatic colors a finite hue", () => {
    expect(Number.isFinite(toOklch("#808080").h)).toBe(true);
  });
});

describe("contrast", () => {
  it("matches WCAG", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });
  it("labels with the stronger of dark and white", () => {
    expect(labelOn("#2ecc71")).toBe("#131313");
    expect(labelOn("#1a237e")).toBe("#ffffff");
  });
});

describe("readableAccent", () => {
  it("keeps every preset as is", () => {
    for (const { hex } of Object.values(PALETTES)) {
      expect(readableAccent(hex)).toEqual({ primary: hex, primaryForeground: "#131313" });
    }
  });

  it("fixes unreadable picks and keeps their hue", () => {
    for (const hex of ["#1a237e", "#fff59d", "#c0392b", "#000000"]) {
      const { primary, primaryForeground } = readableAccent(hex);
      expect(contrast(primary, "#131313")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(primary, "#0d0d0d")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(primary, "#1c1c1c")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(primary, primaryForeground)).toBeGreaterThanOrEqual(4.5);
      if (toOklch(hex).c > 0.02) expect(Math.abs(toOklch(primary).h - toOklch(hex).h)).toBeLessThan(3);
    }
  });
});

describe("deriveTheme guarantees", () => {
  for (const ownAccent of [false, true]) {
    it(`meets every target for all seeds (ownAccent ${ownAccent})`, () => {
      for (const seed of seeds) {
        const t = deriveTheme(seed, { ownAccent });
        const fail = (what: string) => `${seed} ${what}`;
        for (const v of Object.values(t)) expect(isHex(v), fail(v)).toBe(true);
        const surfaces = SURFACE_TOKENS.map((k) => t[k]!);
        for (const s of surfaces) {
          expect(contrast(t["--foreground"]!, s), fail("foreground")).toBeGreaterThanOrEqual(7);
          expect(contrast(t["--muted-foreground"]!, s), fail("muted")).toBeGreaterThanOrEqual(4.5);
          // --destructive is also error text (ErrorText).
          expect(contrast(t["--destructive"]!, s), fail("destructive text")).toBeGreaterThanOrEqual(4.5);
        }
        for (const s of [t["--background"]!, t["--card"]!])
          expect(contrast(t["--input"]!, s), fail("input")).toBeGreaterThanOrEqual(3);
        for (const k of ["--destructive", "--mention", "--online", "--idle"]) {
          for (const s of [t["--sidebar"]!, t["--card"]!]) expect(contrast(t[k]!, s), fail(k)).toBeGreaterThanOrEqual(3);
        }
        expect(contrast(t["--mention"]!, t["--mention-foreground"]!), fail("mention label")).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t["--destructive"]!, t["--destructive-foreground"]!), fail("destructive label")).toBeGreaterThanOrEqual(4.5);
        if (ownAccent) {
          for (const s of [t["--background"]!, t["--sidebar"]!, t["--card"]!])
            expect(contrast(t["--primary"]!, s), fail("primary")).toBeGreaterThanOrEqual(4.5);
          expect(contrast(t["--primary"]!, t["--primary-foreground"]!), fail("primary label")).toBeGreaterThanOrEqual(4.5);
          expect(t["--ring"]).toBe(t["--primary"]);
        } else {
          expect(t["--primary"]).toBeUndefined();
          // The server accent, checked against this theme's surfaces, passes too.
          for (const accent of seeds.slice(0, 40)) {
            const a = readableAccent(accent, [t["--background"]!, t["--sidebar"]!, t["--card"]!]);
            expect(contrast(a.primary, t["--card"]!), fail(`server ${accent}`)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(a.primary, a.primaryForeground), fail(`server label ${accent}`)).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    });
  }
});
