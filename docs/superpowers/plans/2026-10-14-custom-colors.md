# Custom Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server admins pick any accent color (presets + custom), and users build named themes from one seed color, with every derived pair guaranteed WCAG AA.

**Architecture:** A pure OKLCH engine (`lib/color.ts`) moves only lightness until contrast targets pass. The server stores the accent as hex (`accent_color`, replaces the `palette` enum); the client re-checks it on apply. Custom themes live in localStorage and are turned into token maps by the engine at apply time.

**Tech Stack:** Go (huma/v2, pgx, goose), React 18, zustand, shadcn/ui (Radix) + Tailwind v4, vitest, openapi-typescript.

**Spec:** `docs/superpowers/specs/2026-10-14-custom-colors-design.md`

## Global Constraints

- Never commit (AGENTS.md §5). "Commit" steps below mean: stop, the user commits.
- Hex format everywhere: `#rrggbb`, lowercase. Server pattern `^#[0-9a-f]{6}$`.
- Contrast: foreground ≥ 7:1 and muted-foreground ≥ 4.5:1 on every derived surface; input ≥ 3:1 on background and card; primary ≥ 3:1 on background and sidebar; any label on a filled color ≥ 4.5:1; mention/destructive/online/idle ≥ 3:1 on sidebar and card.
- Default surfaces for server-wide accent checks: background `#131313`, sidebar `#0d0d0d`. Dark label `#131313`, light label `#ffffff`.
- Tokens only in UI chrome (no hardcoded colors), except the subject color itself (swatches, picker area, hue track).
- Dark-only; no `dark:` classes. `Button` defaults to `type="button"`.
- Keep the preset radio names (`Emerald`, `Ocean`, …): `e2e/chat.spec.ts` clicks `radio "Ocean"`.
- Max 12 custom themes; names trimmed, 1–32 chars.
- Migration number: next free (00046 after rebasing on main); other parallel sessions may collide at merge.

## Review Focus

- Mid-luminance colors where neither `#131313` nor `#ffffff` reaches 4.5:1 (e.g. luminance ≈ 0.19): label must still pass → `readableAccent` lightens until the dark label passes; tested on `#c0392b`-like reds and the sweep.
- Achromatic seeds (`#000000`, `#808080`, `#ffffff`): hue is meaningless, must not produce NaN → sweep includes them; `toOklch` returns `h: 0` for c≈0.
- Hex typed with uppercase or a missing `#`: the picker must not commit invalid text and must normalize case → `normalizeHex` test.
- Deleting the active custom theme, or a pref pointing at a custom id that no longer exists (other tab deleted it): app falls back to default → `resolveTheme` test.
- Custom theme without own accent on a server whose accent was set through the raw API (unreadable): still readable on the derived background → `use-palette` passes derived surfaces into `readableAccent`; sweep covers `readableAccent` against derived surfaces.

---

## File Structure

| File | Responsibility |
|---|---|
| `clients/web/src/lib/color.ts` (create) | hex/OKLCH/HSV conversion, contrast, `fitLightness`, `readableAccent`, `deriveTheme` |
| `clients/web/src/lib/color.test.ts` (create) | engine tests incl. contrast sweep |
| `server/internal/db/migrations/00046_server_accent.sql` (create) | `palette` → `accent_color` |
| `server/internal/communities/{communities,handlers,invites}.go`, `communities_test.go` (modify) | `AccentColor` field and API |
| `clients/core/src/schema.d.ts`, `openapi.json` (regenerate), `client.test.ts`, `store.test.ts` (modify) | types |
| `clients/web/src/lib/palettes.ts` (modify) | presets as `{label, hex}` |
| `clients/web/src/theme/custom.ts` + `custom.test.ts` (create) | custom theme store, `resolveTheme` |
| `clients/web/src/theme/prefs.ts` + `prefs.test.ts` (modify) | pref may be `custom:<id>` |
| `clients/web/src/hooks/use-theme.ts`, `use-palette.ts`, `pages/use-server-preview.ts` (modify) | apply |
| `clients/web/src/components/color-picker.tsx` (create) | SV area + hue slider + hex input |
| `clients/web/src/app/server-settings/Look.tsx` (modify) | server color section |
| `clients/web/src/app/settings/ThemeBuilder.tsx` (create) | 3-step dialog |
| `clients/web/src/app/settings/AppearanceSettings.tsx` (modify) | custom cards, create, edit, delete |

---

### Task 1: Color engine

**Files:**
- Create: `clients/web/src/lib/color.ts`
- Test: `clients/web/src/lib/color.test.ts`

**Interfaces:**
- Produces:
  - `isHex(s: string): boolean`, `normalizeHex(s: string): string | undefined` (accepts with/without `#`, any case)
  - `type Oklch = { l: number; c: number; h: number }`; `toOklch(hex): Oklch`; `fromOklch(o: Oklch): string`
  - `type Hsv = { h: number; s: number; v: number }` (h 0–360, s/v 0–1); `toHsv(hex): Hsv`; `fromHsv(hsv): string`
  - `contrast(a: string, b: string): number`
  - `fitLightness(hex, against: string[], ratio: number): string` (always lightens)
  - `labelOn(hex): "#131313" | "#ffffff"`
  - `DEFAULT_SURFACES: [string, string]` = `["#131313", "#0d0d0d"]`
  - `readableAccent(hex, surfaces?: string[]): { primary: string; primaryForeground: string }`
  - `deriveTheme(seed: string, opts: { ownAccent: boolean }): Record<string, string>` (CSS var name → hex)
  - `SURFACE_TOKENS = ["--sidebar", "--background", "--card", "--muted", "--secondary"] as const`

- [ ] **Step 1: Write the failing tests** — `color.test.ts`:

```ts
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
      expect(contrast(primary, "#131313")).toBeGreaterThanOrEqual(3);
      expect(contrast(primary, "#0d0d0d")).toBeGreaterThanOrEqual(3);
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
        }
        for (const s of [t["--background"]!, t["--card"]!])
          expect(contrast(t["--input"]!, s), fail("input")).toBeGreaterThanOrEqual(3);
        for (const k of ["--destructive", "--mention", "--online", "--idle"]) {
          for (const s of [t["--sidebar"]!, t["--card"]!]) expect(contrast(t[k]!, s), fail(k)).toBeGreaterThanOrEqual(3);
        }
        expect(contrast(t["--mention"]!, t["--mention-foreground"]!), fail("mention label")).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t["--destructive"]!, t["--destructive-foreground"]!), fail("destructive label")).toBeGreaterThanOrEqual(4.5);
        if (ownAccent) {
          for (const s of [t["--background"]!, t["--sidebar"]!])
            expect(contrast(t["--primary"]!, s), fail("primary")).toBeGreaterThanOrEqual(3);
          expect(contrast(t["--primary"]!, t["--primary-foreground"]!), fail("primary label")).toBeGreaterThanOrEqual(4.5);
          expect(t["--ring"]).toBe(t["--primary"]);
        } else {
          expect(t["--primary"]).toBeUndefined();
          // The server accent, checked against this theme's surfaces, passes too.
          for (const accent of seeds.slice(0, 40)) {
            const a = readableAccent(accent, [t["--background"]!, t["--sidebar"]!]);
            expect(contrast(a.primary, t["--background"]!), fail(`server ${accent}`)).toBeGreaterThanOrEqual(3);
          }
        }
      }
    });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk vitest run src/lib/color.test.ts` (from `clients/web`). Expected: FAIL, cannot resolve `./color`.

- [ ] **Step 3: Implement** — `color.ts`:

```ts
/** Colour maths for server accents and one-colour themes (spec: custom colors). Hex is "#rrggbb", lowercase. */

export type Oklch = { l: number; c: number; h: number };
export type Hsv = { h: number; s: number; v: number };

const HEX = /^#[0-9a-f]{6}$/;
export const isHex = (s: string) => HEX.test(s);

/** "#A1B2C3", "a1b2c3" → "#a1b2c3"; anything else → undefined. */
export function normalizeHex(s: string): string | undefined {
  const t = s.trim().toLowerCase();
  const hex = t.startsWith("#") ? t : `#${t}`;
  return isHex(hex) ? hex : undefined;
}

const DARK = "#131313";
const WHITE = "#ffffff";
/** The default theme's background and sidebar: what a server accent must read against. */
export const DEFAULT_SURFACES = [DARK, "#0d0d0d"];

type Rgb = [number, number, number];
const toRgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
const toHex = (rgb: Rgb) =>
  "#" + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const gam = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055);

export function toOklch(hex: string): Oklch {
  const [r, g, b] = toRgb(hex).map(lin) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  return { l: L, c, h: c < 1e-4 ? 0 : (Math.atan2(B, A) * 180) / Math.PI + (B < 0 ? 360 : 0) };
}

function linearRgb({ l, c, h }: Oklch): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -1e-6 && v <= 1 + 1e-6);

/** OKLCH → hex. Out-of-gamut colours lose chroma (same lightness and hue) until they fit sRGB. */
export function fromOklch(o: Oklch): string {
  const l = Math.min(1, Math.max(0, o.l));
  let rgb = linearRgb({ ...o, l });
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = o.c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(linearRgb({ l, c: mid, h: o.h }))) lo = mid;
      else hi = mid;
    }
    rgb = linearRgb({ l, c: lo, h: o.h });
  }
  return toHex(rgb.map(gam) as Rgb);
}

export function toHsv(hex: string): Hsv {
  const [r, g, b] = toRgb(hex);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

export function fromHsv({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return toHex([f(5), f(3), f(1)]);
}

const luminance = (hex: string) => {
  const [r, g, b] = toRgb(hex).map(lin) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG 2 contrast ratio, 1–21. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** The colour, lightened (hue and chroma kept) just enough to reach `ratio` against every colour in `against`. */
export function fitLightness(hex: string, against: string[], ratio: number): string {
  const passes = (h: string) => against.every((a) => contrast(h, a) >= ratio);
  if (passes(hex)) return hex;
  const o = toOklch(hex);
  let lo = o.l;
  let hi = 1;
  let best = fromOklch({ ...o, l: 1 });
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const h = fromOklch({ ...o, l: mid });
    if (passes(h)) {
      hi = mid;
      best = h;
    } else lo = mid;
  }
  return best;
}

/** Readable text on a filled colour: whichever of near-black and white contrasts more. */
export const labelOn = (hex: string) => (contrast(hex, DARK) >= contrast(hex, WHITE) ? DARK : WHITE);

/** A fill colour that stands out on `surfaces` (≥ 3:1) and carries a label (≥ 4.5:1). Passing colours come back unchanged. */
export function readableAccent(hex: string, surfaces: string[] = DEFAULT_SURFACES) {
  let primary = fitLightness(hex, surfaces, 3);
  if (contrast(primary, labelOn(primary)) < 4.5) primary = fitLightness(primary, [DARK], 4.5);
  return { primary, primaryForeground: labelOn(primary) };
}

/** The surfaces text must read on. */
export const SURFACE_TOKENS = ["--sidebar", "--background", "--card", "--muted", "--secondary"] as const;

/** Every colour token from one seed: surfaces tinted with its hue, text and signals fitted to AA, the accent only if `ownAccent`. */
export function deriveTheme(seed: string, { ownAccent }: { ownAccent: boolean }): Record<string, string> {
  const { c, h } = toOklch(seed);
  const tint = Math.min(c, 0.05);
  const surface = (l: number) => fromOklch({ l, c: tint, h });
  const sidebar = surface(0.16);
  const background = surface(0.195);
  const card = surface(0.235);
  const muted = surface(0.29);
  const secondary = surface(0.37);
  const surfaces = [sidebar, background, card, muted, secondary];
  const text = (l: number, ratio: number) => fitLightness(fromOklch({ l, c: Math.min(tint, 0.02), h }), surfaces, ratio);
  const foreground = text(0.86, 7);
  const signal = (l: number, chroma: number, hue: number) => readableAccent(fromOklch({ l, c: chroma, h: hue }), [sidebar, card]);
  const red = signal(0.64, 0.19, 27);
  const online = signal(0.72, 0.17, 150).primary;
  const idle = signal(0.72, 0.15, 80).primary;
  const vars: Record<string, string> = {
    "--background": background,
    "--foreground": foreground,
    "--card": card,
    "--card-foreground": foreground,
    "--popover": card,
    "--popover-foreground": foreground,
    "--secondary": secondary,
    "--secondary-foreground": foreground,
    "--muted": muted,
    "--muted-foreground": text(0.7, 4.5),
    "--accent": muted,
    "--accent-foreground": foreground,
    "--border": secondary,
    "--input": fitLightness(surface(0.45), [background, card], 3),
    "--sidebar": sidebar,
    "--sidebar-foreground": foreground,
    "--topbar": card,
    "--topbar-foreground": foreground,
    "--destructive": red.primary,
    "--destructive-foreground": red.primaryForeground,
    "--mention": red.primary,
    "--mention-foreground": red.primaryForeground,
    "--online": online,
    "--idle": idle,
  };
  if (ownAccent) {
    const { primary, primaryForeground } = readableAccent(seed, [background, sidebar]);
    Object.assign(vars, { "--primary": primary, "--primary-foreground": primaryForeground, "--ring": primary });
  }
  return vars;
}
```

Note: `PALETTES` must expose `hex` for the preset test; Task 1 changes `palettes.ts` to:

```ts
/** Server colour presets (spec: custom colors §3). Each passes readableAccent unchanged. */
export const PALETTES = {
  emerald: { label: "Emerald", hex: "#2ecc71" },
  ocean: { label: "Ocean", hex: "#4aa3ff" },
  violet: { label: "Violet", hex: "#a78bfa" },
  amber: { label: "Amber", hex: "#f5a524" },
  rose: { label: "Rose", hex: "#fb7185" },
  mint: { label: "Mint", hex: "#2dd4bf" },
} as const;

export type Palette = keyof typeof PALETTES;

/** Role colours a role may have (server/internal/communities RoleColors). */
export const ROLE_COLORS = ["#e74c3c", "#f5a524", "#2ecc71", "#2dd4bf", "#4aa3ff", "#a78bfa", "#fb7185", "#969da2"] as const;
```

(`Look.tsx` and `use-palette.ts` still read `.accent` until Tasks 3/5; `tsc` breaks between Task 1 and Task 3, which is expected when executed in order. Executors running `tsc` after Task 1 should run it after Task 3.)

- [ ] **Step 4: Run tests** — `rtk vitest run src/lib/color.test.ts`. Expected: PASS. If a sweep seed fails, fix the engine (never loosen a target).

- [ ] **Step 5: Stop for the user to commit** (`feat(web): OKLCH colour engine with AA guarantees`).

---

### Task 2: Server `accent_color`

**Files:**
- Create: `server/internal/db/migrations/00046_server_accent.sql` (use the next free number)
- Modify: `server/internal/communities/communities.go:42-50,155-156`, `handlers.go:21,119-120,132`, `invites.go:43,63`
- Test: `server/internal/communities/communities_test.go:67-75,182`
- Regenerate: `clients/core/openapi.json`, `clients/core/src/schema.d.ts`; modify `clients/core/src/client.test.ts:171`, `store.test.ts:12,117-118`

**Interfaces:**
- Produces: JSON `accent_color: string` on `Server` and `ServerPreview`; `PATCH /api/server` body `accent_color?: string`. TS: `ServerPreview["accent_color"]`, `server.accent_color`.

- [ ] **Step 1: Update the Go tests first**

`communities_test.go` TestUpdateServer:

```go
	alice.Do(http.MethodPatch, "/api/server", map[string]any{"name": "The Basement", "description": "Board games and links", "accent_color": "#1a237e"}, http.StatusOK, &s)
	require.Equal(t, "The Basement", s.Name)
	require.Equal(t, "#1a237e", s.AccentColor)
```

and the failure cases:

```go
	alice.Fail(http.MethodPatch, "/api/server", map[string]any{"accent_color": "beige"}, http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Fail(http.MethodPatch, "/api/server", map[string]any{"accent_color": "#1A237E"}, http.StatusBadRequest, "VALIDATION_FAILED")
```

Preview test: `require.Equal(t, "#2ecc71", p.AccentColor)`.

- [ ] **Step 2: Run** `rtk go test ./internal/communities/...` (from `server`). Expected: compile FAIL (`AccentColor` undefined).

- [ ] **Step 3: Migration**

```sql
-- +goose Up
-- Servers pick any accent colour, not one of six palettes (spec: custom colors §2).
ALTER TABLE communities ADD COLUMN accent_color TEXT NOT NULL DEFAULT '#2ecc71'
    CHECK (accent_color ~ '^#[0-9a-f]{6}$');
UPDATE communities SET accent_color = CASE palette
    WHEN 'ocean' THEN '#4aa3ff' WHEN 'violet' THEN '#a78bfa' WHEN 'amber' THEN '#f5a524'
    WHEN 'rose' THEN '#fb7185' WHEN 'mint' THEN '#2dd4bf' ELSE '#2ecc71' END;
ALTER TABLE communities DROP COLUMN palette;

-- +goose Down
ALTER TABLE communities ADD COLUMN palette TEXT NOT NULL DEFAULT 'emerald'
    CHECK (palette IN ('emerald', 'ocean', 'violet', 'amber', 'rose', 'mint'));
UPDATE communities SET palette = CASE accent_color
    WHEN '#4aa3ff' THEN 'ocean' WHEN '#a78bfa' THEN 'violet' WHEN '#f5a524' THEN 'amber'
    WHEN '#fb7185' THEN 'rose' WHEN '#2dd4bf' THEN 'mint' ELSE 'emerald' END;
ALTER TABLE communities DROP COLUMN accent_color;
```

- [ ] **Step 4: Go code**

`communities.go`: delete the `Palettes` var and its comment; in `Server` replace the `Palette` line with

```go
	AccentColor string    `json:"accent_color" pattern:"^#[0-9a-f]{6}$" doc:"The server's accent colour; clients lighten it if it is too dark to read"`
```

and in `Server(ctx)` select `accent_color` instead of `palette`, scanning into `&sv.AccentColor`.

`handlers.go`: `AccentColor *string \`json:"accent_color,omitempty" pattern:"^#[0-9a-f]{6}$"\``; SQL `accent_color = COALESCE($4, accent_color)` with `in.Body.AccentColor`; `cs = audit.Diff(cs, "accent_color", old.AccentColor, sv.AccentColor)`.

`invites.go`: `AccentColor string \`json:"accent_color" pattern:"^#[0-9a-f]{6}$"\``; `AccentColor: sv.AccentColor` in `serverPreview`.

Then `rtk grep -n "Palette" server/internal --include=*.go` must show only image/gif hits.

- [ ] **Step 5: Run** `rtk go test ./internal/communities/... ./internal/audit/...`. Expected: PASS.

- [ ] **Step 6: Regenerate types** — `rtk pnpm --filter @datrope/core gen`. Then in `client.test.ts:171` and `store.test.ts:12` replace `palette: "emerald"` with `accent_color: "#2ecc71"`; `store.test.ts:117-118` becomes `{ ...server, name: "Basement", accent_color: "#4aa3ff" }` and `expect(s.server?.server.accent_color).toBe("#4aa3ff")`. Run `rtk vitest run` in `clients/core`. Expected: PASS.

- [ ] **Step 7: Stop for the user to commit** (`feat(server): accent_color replaces palette`).

---

### Task 3: Apply the server accent

**Files:**
- Modify: `clients/web/src/hooks/use-palette.ts`, `clients/web/src/pages/use-server-preview.ts:18`

**Interfaces:**
- Consumes: `readableAccent`, `DEFAULT_SURFACES` (Task 1); `server.accent_color` (Task 2); `useActiveTheme()` (Task 4 — until then, use the built-in check shown below).
- Produces: `useApplyAccent(hex?: string)`, `usePalette()` (name kept; AppShell calls it).

- [ ] **Step 1: Implement** `use-palette.ts`:

```ts
import { useEffect } from "react";
import { DEFAULT_SURFACES, readableAccent } from "@/lib/color";
import { useApp } from "@/session";
import { useActiveTheme } from "@/theme/custom";

/** Applies the server's accent to --primary, --primary-foreground and --ring. A theme with its own accent wins. */
export function usePalette() {
  useApplyAccent(useApp((s) => s.server?.server.accent_color));
}

/** usePalette for an accent known outside the store (the auth pages). */
export function useApplyAccent(hex?: string) {
  const theme = useActiveTheme();
  const owns = theme.ownsAccent;
  const surfaces = theme.surfaces?.join(",") ?? DEFAULT_SURFACES.join(",");
  useEffect(() => {
    if (!hex || owns) return;
    const root = document.documentElement.style;
    const { primary, primaryForeground } = readableAccent(hex, surfaces.split(","));
    root.setProperty("--primary", primary);
    root.setProperty("--primary-foreground", primaryForeground);
    root.setProperty("--ring", primary);
    return () => {
      root.removeProperty("--primary");
      root.removeProperty("--primary-foreground");
      root.removeProperty("--ring");
    };
  }, [hex, owns, surfaces]);
}
```

`use-server-preview.ts`: import `useApplyAccent` and call `useApplyAccent(preview?.accent_color)`.

(Executed before Task 4: implement Task 4's `useActiveTheme` first, or do Tasks 3 and 4 together. Order in this plan: do Task 4 Steps 1–4, then this task.)

- [ ] **Step 2: Verify** `rtk tsc` in `clients/web` after Task 5 compiles `Look.tsx`; run `rtk vitest run`.

- [ ] **Step 3: Stop for the user to commit** together with Task 4.

---

### Task 4: Custom theme store and apply

**Files:**
- Create: `clients/web/src/theme/custom.ts`, `clients/web/src/theme/custom.test.ts`
- Modify: `clients/web/src/theme/prefs.ts`, `clients/web/src/theme/prefs.test.ts`, `clients/web/src/hooks/use-theme.ts`

**Interfaces:**
- Consumes: `deriveTheme`, `normalizeHex` (Task 1).
- Produces:
  - `prefs.ts`: `type ThemePref = ThemeId | \`custom:${string}\``; `sanitize(raw): ThemePref`; `useThemeId(): ThemePref`; `setTheme(t: ThemePref)`.
  - `custom.ts`: `type CustomTheme = { id: string; name: string; seed: string; ownAccent: boolean }`; `MAX_CUSTOM_THEMES = 12`; `sanitizeList(raw: unknown): CustomTheme[]`; `useCustomThemes(): CustomTheme[]`; `saveCustomTheme(t: CustomTheme): void`; `removeCustomTheme(id: string): void`; `newThemeId(): string`; `customPref(id): \`custom:${string}\``; `resolveTheme(pref: ThemePref, list: CustomTheme[]): { vars?: Record<string,string>; ownsAccent: boolean; surfaces?: string[] }`; `useActiveTheme()` (same return, from the stores).

- [ ] **Step 1: Failing tests** — `custom.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveTheme, sanitizeList, MAX_CUSTOM_THEMES } from "./custom";

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
    expect(custom.surfaces).toEqual([custom.vars!["--background"], custom.vars!["--sidebar"]]);
    expect(resolveTheme("custom:a", [{ ...t, ownAccent: true }]).ownsAccent).toBe(true);
  });

  it("falls back to the default for a deleted custom theme", () => {
    expect(resolveTheme("custom:gone", [t])).toEqual({ ownsAccent: false });
  });
});
```

Append to `prefs.test.ts`:

```ts
  it("keeps a custom theme reference", () => {
    expect(sanitize("custom:abc")).toBe("custom:abc");
    expect(sanitize("custom:")).toBe("datrope");
  });
```

- [ ] **Step 2: Run** `rtk vitest run src/theme`. Expected: FAIL (no `./custom`; prefs test fails).

- [ ] **Step 3: Implement**

`prefs.ts` changes:

```ts
import { DEFAULT_THEME, THEMES, type ThemeId } from "./themes";

/** A built-in theme, or "custom:<id>" for one of my custom themes. */
export type ThemePref = ThemeId | `custom:${string}`;

const KEY = "datrope.theme";

/** A known theme ID or a custom theme reference, else the default. */
export function sanitize(raw: unknown): ThemePref {
  if (typeof raw !== "string") return DEFAULT_THEME;
  if (/^custom:.+/.test(raw)) return raw as ThemePref;
  return Object.hasOwn(THEMES, raw) ? (raw as ThemeId) : DEFAULT_THEME;
}
```

and `ThemeId` → `ThemePref` in `load`, the store type, and `setTheme`.

`custom.ts`:

```ts
import { useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { deriveTheme, normalizeHex } from "@/lib/color";
import { setTheme, themePrefNow, useThemeId, type ThemePref } from "./prefs";
import { DEFAULT_THEME } from "./themes";

/** A theme I made from one colour (spec: custom colors §4). Kept on this device. */
export type CustomTheme = { id: string; name: string; seed: string; ownAccent: boolean };

export const MAX_CUSTOM_THEMES = 12;
const KEY = "datrope.customThemes";

/** Valid themes only: unique id, a 1–32 character name, a hex seed; at most MAX_CUSTOM_THEMES. */
export function sanitizeList(raw: unknown): CustomTheme[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomTheme[] = [];
  for (const t of raw) {
    if (out.length === MAX_CUSTOM_THEMES) break;
    if (!t || typeof t !== "object") continue;
    const { id, name, seed, ownAccent } = t as Record<string, unknown>;
    const n = typeof name === "string" ? name.trim().slice(0, 32) : "";
    const hex = typeof seed === "string" ? normalizeHex(seed) : undefined;
    if (typeof id !== "string" || !id || !n || !hex || out.some((o) => o.id === id)) continue;
    out.push({ id, name: n, seed: hex, ownAccent: ownAccent === true });
  }
  return out;
}

function load(): CustomTheme[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? [] : sanitizeList(JSON.parse(raw));
  } catch {
    return [];
  }
}

const customThemes = createStore<{ list: CustomTheme[] }>(() => ({ list: load() }));

customThemes.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s.list));
  } catch {
    // Storage unavailable (private window): kept in memory only.
  }
});

export const useCustomThemes = () => useStore(customThemes, (s) => s.list);

export const customPref = (id: string): ThemePref => `custom:${id}`;
export const newThemeId = () => Math.random().toString(36).slice(2, 10);

/** Adds the theme, or replaces the one with its id. Adding past the limit does nothing. */
export function saveCustomTheme(t: CustomTheme) {
  customThemes.setState(({ list }) => ({
    list: list.some((o) => o.id === t.id) ? list.map((o) => (o.id === t.id ? t : o)) : sanitizeList([...list, t]),
  }));
}

export function removeCustomTheme(id: string) {
  customThemes.setState(({ list }) => ({ list: list.filter((o) => o.id !== id) }));
}

/** What the active theme sets: its tokens (none for the default), whether it owns the accent, and the surfaces a server accent must read on. */
export function resolveTheme(pref: ThemePref, list: CustomTheme[]): { vars?: Record<string, string>; ownsAccent: boolean; surfaces?: string[] } {
  if (pref === DEFAULT_THEME) return { ownsAccent: false };
  if (!pref.startsWith("custom:")) return { ownsAccent: true };
  const t = list.find((o) => `custom:${o.id}` === pref);
  if (!t) return { ownsAccent: false };
  const vars = deriveTheme(t.seed, { ownAccent: t.ownAccent });
  return { vars, ownsAccent: t.ownAccent, surfaces: [vars["--background"]!, vars["--sidebar"]!] };
}

export function useActiveTheme() {
  const pref = useThemeId();
  const list = useCustomThemes();
  return useMemo(() => resolveTheme(pref, list), [pref, list]);
}

// The active custom theme went away (deleted here or in another tab): back to the default.
customThemes.subscribe(({ list }) => {
  const pref = themePrefNow();
  if (pref.startsWith("custom:") && !list.some((o) => `custom:${o.id}` === pref)) setTheme(DEFAULT_THEME);
});

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) customThemes.setState({ list: load() });
  });
}
```

Add to `prefs.ts` the non-hook getter `custom.ts` uses: `export const themePrefNow = () => themePref.getState().theme;`.

`use-theme.ts`:

```ts
import { useLayoutEffect } from "react";
import { useActiveTheme } from "@/theme/custom";
import { useThemeId } from "@/theme/prefs";
import { DEFAULT_THEME, THEMES, themeVars, type ThemeId } from "@/theme/themes";

/** Applies my theme's tokens on <html>; the default theme is styles.css itself. */
export function useTheme() {
  const id = useThemeId();
  const custom = useActiveTheme().vars;
  useLayoutEffect(() => {
    const vars = id.startsWith("custom:") ? custom : id === DEFAULT_THEME ? undefined : themeVars(THEMES[id as ThemeId].colors);
    if (!vars) return;
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
    return () => {
      for (const k of Object.keys(vars)) root.removeProperty(k);
    };
  }, [id, custom]);
}
```

Also update `AppearanceSettings.tsx`'s `setTheme(v as ThemeId)` to `setTheme(v as ThemePref)` (full rewrite in Task 7).

- [ ] **Step 4: Run** `rtk vitest run src/theme`. Expected: PASS.

- [ ] **Step 5: Do Task 3, then stop for the user to commit** (`feat(web): custom themes from one colour; server accent applied readably`).

---

### Task 5: ColorPicker component

**Files:**
- Create: `clients/web/src/components/color-picker.tsx`

**Interfaces:**
- Consumes: `toHsv`, `fromHsv`, `normalizeHex` (Task 1); shadcn `Slider`, `Input`.
- Produces: `ColorPicker({ value, onChange }: { value: string; onChange: (hex: string) => void })`.

- [ ] **Step 1: Implement**

```tsx
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { fromHsv, normalizeHex, toHsv, type Hsv } from "@/lib/color";

const HUES = "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)";

/** Saturation/brightness area, hue slider and hex field. The colours drawn are the subject itself, so they are literal. */
export function ColorPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [hsv, setHsv] = useState<Hsv>(() => toHsv(value));
  const [text, setText] = useState(value);
  // A new value from outside (a preset): follow it, unless it is what we just produced.
  useEffect(() => {
    if (fromHsv(hsv) !== value) setHsv(toHsv(value));
    setText(value);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (next: Hsv) => {
    setHsv(next);
    onChange(fromHsv(next));
  };

  const area = useRef<HTMLDivElement>(null);
  const fromPointer = (e: PointerEvent) => {
    const r = area.current!.getBoundingClientRect();
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    set({ ...hsv, s: clamp((e.clientX - r.left) / r.width), v: clamp(1 - (e.clientY - r.top) / r.height) });
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    set({ ...hsv, s: clamp(hsv.s + d[0]!), v: clamp(hsv.v + d[1]!) });
  };

  return (
    <div className="grid gap-3">
      <div
        ref={area}
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          fromPointer(e);
        }}
        onPointerMove={(e) => e.buttons && fromPointer(e)}
        onKeyDown={onKey}
        className="relative h-36 cursor-crosshair touch-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${fromHsv({ h: hsv.h, s: 1, v: 1 })})` }}
      >
        <span aria-hidden className="absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.6)]"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </div>
      <Slider aria-label="Hue" min={0} max={360} step={1} value={[hsv.h]} onValueChange={([h]) => set({ ...hsv, h: h! })}
        style={{ "--hues": HUES } as CSSProperties}
        className="[&_[data-slot=slider-range]]:bg-transparent [&_[data-slot=slider-track]]:h-3 [&_[data-slot=slider-track]]:[background:var(--hues)]" />
      <div className="flex items-center gap-2">
        <span aria-hidden className="size-8 shrink-0 rounded-md border" style={{ background: value }} />
        <Input aria-label="Hex" value={text} spellCheck={false} className="w-28 font-mono"
          onChange={(e) => {
            setText(e.target.value);
            const hex = normalizeHex(e.target.value);
            if (hex) {
              setHsv(toHsv(hex));
              onChange(hex);
            }
          }}
          onBlur={() => setText(value)} />
      </div>
    </div>
  );
}
```

(`border-white` and the shadow on the handle: the handle sits on the subject colour, so it needs a fixed light ring with a dark halo to be visible on any colour; it is part of the subject drawing, like the gradients.)

- [ ] **Step 2: Verify** with Task 6 in the browser (no unit test: pointer maths is exercised in the preview).

---

### Task 6: Server settings → Look

**Files:**
- Modify: `clients/web/src/app/server-settings/Look.tsx:1-100`, `clients/web/src/pages/Register.tsx:28` (copy: "Icon, banner, colour and the welcome page.")

**Interfaces:**
- Consumes: `ColorPicker` (Task 5), `readableAccent` (Task 1), `PALETTES` with `hex` (Task 1), `accent_color` API (Task 2).

- [ ] **Step 1: Implement** — replace `Look` and `Preview` (keep `ImageUpload` unchanged):

```tsx
import { unwrap } from "@datrope/core";
import { Hash } from "lucide-react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { useRef, useState, type CSSProperties } from "react";
import { ColorPicker } from "@/components/color-picker";
import { ErrorText } from "@/components/error-text";
import { Logo, ServerIcon } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { RadioGroup } from "@/components/ui/radio-group";
import { useSubmit } from "@/hooks/use-submit";
import { readableAccent } from "@/lib/color";
import { PALETTES, type Palette } from "@/lib/palettes";
import { client, useApp } from "@/session";
import { sizedImage } from "@/lib/sized-image";

const ITEM = "grid justify-items-start gap-2.5 rounded-lg border bg-card p-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:border-[var(--swatch)] data-[state=checked]:ring-1 data-[state=checked]:ring-[var(--swatch)]";

/** Server colour, icon and banner (MANAGE_SERVER). A preset saves as soon as it is picked; a custom colour on "Use colour". */
export function Look() {
  const name = useApp((s) => s.server?.server.name ?? "");
  const saved = useApp((s) => s.server?.server.accent_color ?? PALETTES.emerald.hex);
  const [picked, setPicked] = useState<string>();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(saved);
  const current = picked ?? saved;
  const preset = (Object.keys(PALETTES) as Palette[]).find((p) => PALETTES[p].hex === current);
  const { error, run } = useSubmit();

  const save = (hex: string) => {
    setPicked(hex);
    void run(async () => {
      try {
        client.apply("SERVER_UPDATE", await unwrap(client.api.PATCH("/api/server", { body: { accent_color: hex } })));
      } finally {
        setPicked(undefined);
      }
    });
  };
  const used = readableAccent(draft).primary;
  const customSwatch = preset ? "conic-gradient(#f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" : current;

  return (
    <>
      <p className="max-w-[68ch] text-muted-foreground">Choose how {name} looks for everyone: its colour, icon and banner.</p>
      <section className="grid gap-1.5" aria-labelledby="look-color">
        <h3 id="look-color" className="text-sm font-semibold">Server colour</h3>
        <p className="text-sm text-muted-foreground">
          The accent colour for buttons, links, mentions, the active channel and the logo. Everyone sees the server in this colour.
        </p>
        <Popover open={open} onOpenChange={setOpen}>
          <RadioGroup aria-labelledby="look-color" value={preset ?? "custom"}
            onValueChange={(v) => v !== "custom" && save(PALETTES[v as Palette].hex)}
            className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2.5">
            {(Object.keys(PALETTES) as Palette[]).map((p) => (
              <RadioGroupPrimitive.Item key={p} value={p} aria-label={PALETTES[p].label}
                style={{ "--swatch": PALETTES[p].hex } as CSSProperties} className={ITEM}>
                <span className="flex gap-1" aria-hidden>
                  <span className="size-7 rounded-full bg-[var(--swatch)]" />
                  <span className="size-7 rounded-full bg-[var(--swatch)] opacity-25" />
                </span>
                <span className="text-sm font-semibold">{PALETTES[p].label}</span>
              </RadioGroupPrimitive.Item>
            ))}
            <PopoverAnchor asChild>
              <RadioGroupPrimitive.Item value="custom" aria-label="Custom"
                onClick={() => { setDraft(current); setOpen(true); }}
                style={{ "--swatch": preset ? "var(--foreground)" : current } as CSSProperties} className={ITEM}>
                <span className="size-7 rounded-full" style={{ background: customSwatch }} aria-hidden />
                <span className="text-sm font-semibold">Custom</span>
              </RadioGroupPrimitive.Item>
            </PopoverAnchor>
          </RadioGroup>
          <PopoverContent align="start" className="grid w-72 gap-3" aria-label="Custom colour">
            <ColorPicker value={draft} onChange={setDraft} />
            {used !== draft && (
              <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                Picked <Chip hex={draft} /> → used <Chip hex={used} /> so text stays readable.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button size="sm" onClick={() => { save(used); setOpen(false); }}>Use colour</Button>
            </div>
          </PopoverContent>
        </Popover>
        <ErrorText error={error} />
      </section>

      <section className="grid gap-1.5">
        <span className="text-sm font-semibold">Preview</span>
        <Preview name={name} accent={open ? used : current} />
      </section>

      <section className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
        <ImageUpload kind="icon" />
        <ImageUpload kind="banner" />
      </section>
    </>
  );
}

/** A colour and its hex. */
function Chip({ hex }: { hex: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
      <span className="size-3 rounded-sm" style={{ background: hex }} aria-hidden />{hex}
    </span>
  );
}

function Preview({ name, accent }: { name: string; accent: string }) {
  const { primary, primaryForeground } = readableAccent(accent);
  const style = { "--primary": primary, "--primary-foreground": primaryForeground, "--ring": primary } as CSSProperties;
  /* …the existing Preview body unchanged, with aria-label "Preview of the server colour"… */
}
```

The `Preview` body is the existing JSX from `Look.tsx:77-96` verbatim; only its `style` line and `aria-label` change as shown. Also update `ImageUpload`'s icon copy "in the palette colour" → "in the server colour".

- [ ] **Step 2: Verify** `rtk tsc` and `rtk vitest run` in `clients/web` pass; then the browser check in Task 8.

- [ ] **Step 3: Stop for the user to commit** with Task 5 (`feat(web): server colour picker`).

---

### Task 7: Appearance custom themes and builder

**Files:**
- Create: `clients/web/src/app/settings/ThemeBuilder.tsx`
- Modify: `clients/web/src/app/settings/AppearanceSettings.tsx`

**Interfaces:**
- Consumes: `ColorPicker` (5); `deriveTheme`, `readableAccent` (1); `CustomTheme`, `saveCustomTheme`, `removeCustomTheme`, `newThemeId`, `customPref`, `useCustomThemes`, `MAX_CUSTOM_THEMES` (4); `setTheme`, `useThemeId`, `ThemePref` (4).
- Produces: `ThemeBuilder({ theme, count, onClose }: { theme?: CustomTheme; count: number; onClose: () => void })`.

- [ ] **Step 1: ThemeBuilder**

```tsx
import { Hash } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { ColorPicker } from "@/components/color-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { deriveTheme, readableAccent } from "@/lib/color";
import { cn } from "@/lib/utils";
import { useApp } from "@/session";
import { customPref, newThemeId, saveCustomTheme, type CustomTheme } from "@/theme/custom";
import { setTheme } from "@/theme/prefs";

const STEPS = ["Pick a colour", "Review palette", "Name it"] as const;
const LADDER = [
  ["Sidebar", "--sidebar"], ["Background", "--background"], ["Card", "--card"], ["Hover", "--muted"], ["Border", "--border"],
  ["Text", "--foreground"], ["Muted text", "--muted-foreground"], ["Accent", "--primary"], ["Mention", "--mention"], ["Online", "--online"],
] as const;

/** Create or edit a custom theme in three steps (spec: custom colors §5). */
export function ThemeBuilder({ theme, count, onClose }: { theme?: CustomTheme; count: number; onClose: () => void }) {
  const serverAccent = useApp((s) => s.server?.server.accent_color ?? "#2ecc71");
  const [step, setStep] = useState(0);
  const [seed, setSeed] = useState(theme?.seed ?? "#4aa3ff");
  const [ownAccent, setOwnAccent] = useState(theme?.ownAccent ?? false);
  const [name, setName] = useState(theme?.name ?? `Custom ${count + 1}`);
  const vars = deriveTheme(seed, { ownAccent });
  if (!ownAccent) {
    const a = readableAccent(serverAccent, [vars["--background"]!, vars["--sidebar"]!]);
    Object.assign(vars, { "--primary": a.primary, "--primary-foreground": a.primaryForeground, "--ring": a.primary });
  }
  const trimmed = name.trim();

  const save = () => {
    const id = theme?.id ?? newThemeId();
    saveCustomTheme({ id, name: trimmed.slice(0, 32), seed, ownAccent });
    setTheme(customPref(id));
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{theme ? "Edit theme" : "Create theme"}</DialogTitle>
          <DialogDescription>{`Step ${step + 1} of 3: ${STEPS[step]}`}</DialogDescription>
        </DialogHeader>
        <ol className="flex gap-1.5" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === step ? "step" : undefined} className={cn("h-1 flex-1 rounded-full bg-muted", i <= step && "bg-primary")}>
              <span className="sr-only">{s}</span>
            </li>
          ))}
        </ol>

        {step === 0 && <ColorPicker value={seed} onChange={setSeed} />}

        {step === 1 && (
          <div className="grid gap-3">
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-1.5" aria-label="Palette">
              {LADDER.map(([label, token]) => (
                <li key={token} className="grid min-h-14 content-between rounded-md border border-border/50 p-2"
                  style={{ background: vars[token], color: token === "--foreground" || token === "--muted-foreground" ? vars["--background"] : vars[`${token}-foreground`] ?? vars["--foreground"] }}>
                  <span className="text-xs font-semibold">{label}</span>
                  <span className="font-mono text-[11px]">{vars[token]}</span>
                </li>
              ))}
            </ul>
            <ThemePreview vars={vars} />
            <div className="flex items-center gap-2">
              <Switch id="own-accent" checked={ownAccent} onCheckedChange={setOwnAccent} />
              <Label htmlFor="own-accent">Use my colour for accents</Label>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="grid gap-1.5">
            <Label htmlFor="theme-name">Theme name</Label>
            <Input id="theme-name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
          </div>
        )}

        <DialogFooter>
          {step > 0 && <Button variant="outline" onClick={() => setStep(step - 1)}>Back</Button>}
          {step < 2 ? <Button onClick={() => setStep(step + 1)}>Next</Button>
            : <Button disabled={!trimmed} onClick={save}>Save theme</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The app in miniature, wearing `vars` through the token utilities. */
export function ThemePreview({ vars }: { vars: Record<string, string> }) {
  return (
    <div aria-label="Preview of the theme" style={vars as CSSProperties}
      className="grid min-h-36 grid-cols-[120px_minmax(0,1fr)] overflow-hidden rounded-lg border text-sm">
      <div className="grid content-start gap-1 bg-sidebar p-2 text-sidebar-foreground">
        <span className="flex items-center gap-1.5 rounded-md bg-accent px-2 py-1"><Hash className="size-3.5" aria-hidden />general</span>
        <span className="flex items-center gap-1.5 px-2 py-1 text-muted-foreground"><Hash className="size-3.5" aria-hidden />games
          <span className="ml-auto rounded-full bg-mention px-1.5 text-xs font-bold text-mention-foreground">3</span></span>
        <span className="flex items-center gap-1.5 px-2 py-1"><span className="size-2 rounded-full bg-online" aria-hidden />filip</span>
      </div>
      <div className="grid content-start gap-2 bg-background p-3 text-foreground">
        <p><span className="rounded bg-primary/20 px-1 font-semibold">@you</span> looks great. <span className="text-primary">See the docs</span></p>
        <p className="text-muted-foreground">12:05 · agreed</p>
        <div className="flex gap-2">
          <Button size="sm" tabIndex={-1}>Send</Button>
          <Button size="sm" variant="outline" tabIndex={-1}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
```

Confirm `bg-mention`, `text-mention-foreground`, `bg-online` utilities exist in `styles.css` `@theme inline` (`rtk grep -n "color-mention\|color-online" clients/web/src/styles.css`); add `--color-mention`/`--color-mention-foreground` there if missing.

- [ ] **Step 2: AppearanceSettings**

```tsx
import { MoreHorizontal, Plus } from "lucide-react";
import { forwardRef, useState, type ComponentProps } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { deriveTheme } from "@/lib/color";
import { customPref, MAX_CUSTOM_THEMES, removeCustomTheme, useCustomThemes, type CustomTheme } from "@/theme/custom";
import { setTheme, useThemeId, type ThemePref } from "@/theme/prefs";
import { THEMES, THEME_IDS, themeVars } from "@/theme/themes";
import { ThemeBuilder } from "./ThemeBuilder";

const CARD = "grid cursor-pointer gap-2 rounded-lg border p-2.5 font-normal hover:bg-accent has-[[data-state=checked]]:border-primary";

/** Theme picker: built-in themes, my custom themes, and "Create theme". */
export function AppearanceSettings() {
  const theme = useThemeId();
  const customs = useCustomThemes();
  const [editing, setEditing] = useState<CustomTheme | "new">();
  const [deleting, setDeleting] = useState<CustomTheme>();
  const full = customs.length >= MAX_CUSTOM_THEMES;

  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">Themes stay on this device. Dark themes from slackthemes.net, or make your own from one colour.</p>
      <RadioGroup aria-label="Theme" value={theme} onValueChange={(v) => setTheme(v as ThemePref)}
        className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
        {THEME_IDS.map((id) => {
          const { label, colors: c } = THEMES[id];
          return (
            <Label key={id} htmlFor={`theme-${id}`} className={CARD}>
              <Thumb sidebar={c.column_bg} main={themeVars(c)["--background"]!} bar={c.top_nav_bg} items={[c.text_color, c.active_item, c.hover_item]} />
              <span className="flex items-center gap-2"><RadioGroupItem id={`theme-${id}`} value={id} />{label}</span>
            </Label>
          );
        })}
        {customs.map((t) => {
          const v = deriveTheme(t.seed, { ownAccent: true });
          return (
            <Label key={t.id} htmlFor={`theme-${t.id}`} className={CARD}>
              <Thumb sidebar={v["--sidebar"]!} main={v["--background"]!} bar={v["--card"]!} items={[v["--foreground"]!, v["--primary"]!, v["--muted"]!]} />
              <span className="flex items-center gap-2">
                <RadioGroupItem id={`theme-${t.id}`} value={customPref(t.id)} />
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <MenuButton aria-label={`Options for ${t.name}`} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setEditing(t)}>Edit</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(t)}>Delete</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
            </Label>
          );
        })}
      </RadioGroup>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={full} onClick={() => setEditing("new")}><Plus aria-hidden />Create theme</Button>
        {full && <span className="text-sm text-muted-foreground">You have {MAX_CUSTOM_THEMES} custom themes. Delete one to make another.</span>}
      </div>

      {editing && <ThemeBuilder theme={editing === "new" ? undefined : editing} count={customs.length} onClose={() => setEditing(undefined)} />}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>The theme is removed from this device.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleting && removeCustomTheme(deleting.id)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const MenuButton = forwardRef<HTMLButtonElement, ComponentProps<typeof Button>>((props, ref) => (
  <Button ref={ref} size="icon" variant="ghost" className="size-6" onClick={(e) => e.preventDefault()} {...props}><MoreHorizontal aria-hidden /></Button>
));

/** A theme in miniature: sidebar with three items, the main area with its top bar. */
function Thumb({ sidebar, main, bar, items }: { sidebar: string; main: string; bar: string; items: [string, string, string] }) {
  return (
    <span aria-hidden className="flex h-14 overflow-hidden rounded-md border">
      <span className="grid w-1/3 content-start gap-1 p-1.5" style={{ background: sidebar }}>
        <span className="h-1.5 rounded-sm" style={{ background: items[0], opacity: 0.6 }} />
        <span className="h-1.5 rounded-sm" style={{ background: items[1] }} />
        <span className="h-1.5 rounded-sm" style={{ background: items[2] }} />
      </span>
      <span className="flex-1" style={{ background: main }}><span className="block h-3" style={{ background: bar }} /></span>
    </span>
  );
}
```

Check before writing: `Button` forwards refs? (React 18, generated components don't; `MenuButton` passes `ref` to `Button`, so wrap `Button`'s inner `<button>` — if `Button` does not accept `ref`, render a plain `<button>` with `buttonVariants({ variant: "ghost", size: "icon" })` instead.) `AlertDialogAction` `variant` prop and `DropdownMenuItem` `variant="destructive"` exist in the new-york v4 components; check the local files and fall back to `className="text-destructive"` if not. The built-in thumbnail keeps today's look (previously `color-mix` of column bg and background, now the themeVars background directly, which is the same mix).

- [ ] **Step 3: Verify** `rtk tsc`, `rtk vitest run`, `rtk lint` in `clients/web`.

- [ ] **Step 4: Stop for the user to commit** (`feat(web): build themes from one colour`).

---

### Task 8: Browser verification

- [ ] **Step 1:** Start the dev stack per `.claude/launch.json` (`preview_start`), sign in with seed/test users from the project's fixtures.
- [ ] **Step 2:** Server settings → Look: click Ocean → buttons recolor (`getComputedStyle` of a primary button = `rgb(74, 163, 255)`). Open Custom, type `#1a237e` → "Picked → used" row shown; Use colour → app accent is the used hex; reload keeps it.
- [ ] **Step 3:** Settings → Appearance → Create theme: pick a color, Next, check ladder + preview, toggle accent switch, Next, name, Save → theme applies and card is selected. Edit it, change seed, save. Delete it → back to Datrope. Reload persists.
- [ ] **Step 4:** Console has no errors; screenshot of Look and of the builder step 2 for the user.
- [ ] **Step 5:** `rtk pnpm --filter web e2e` if the e2e environment is available (chat.spec checks the Ocean radio); otherwise note it as unverified.
- [ ] **Step 6:** Report to the user; flag migration number may collide at merge.
