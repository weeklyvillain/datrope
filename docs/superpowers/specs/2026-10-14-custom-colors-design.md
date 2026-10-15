# Custom colors: server color picker and one-color user themes

Date: 2026-10-14. Mockups: `docs/superpowers/mockups/2026-10-14-custom-colors.html` (concept C chosen, contrast ratios hidden).

## Goal

1. A server admin can give the server any accent color, not just the six palettes.
2. A user can create their own theme by picking one color; every other token is derived automatically and is guaranteed readable (WCAG AA).

## Decisions

| Question | Decision |
|---|---|
| Server color input | Six presets stay as quick picks, plus a custom picker (saturation/value area, hue slider, hex field). Stored as hex. |
| Unreadable picks | Keep the hue, move OKLCH lightness until it passes. The admin sees "Picked → Used" swatches; the used hex is saved. The client also adjusts on apply (raw API writes). |
| What a user seed drives | All surfaces (sidebar, background, cards, borders, hover), text, plus optionally the accent. |
| Accent precedence | A custom theme follows the server accent unless its "Use my color for accents" switch is on. Built-in Slack themes keep today's behavior (they override the server accent). |
| Storage | This device only (localStorage), like the existing themes. Several named custom themes, max 12. |
| Contrast | AA: text ≥ 4.5:1 (foreground targets 7:1 for hierarchy headroom), UI parts ≥ 3:1 (accent on background and sidebar, input border, mention and presence dots). Decorative borders and hover fills are exempt (WCAG 1.4.11 does not cover them). |
| Color math | In-house OKLCH module, no dependency. CSS-only (`oklch(from …)`) rejected: it cannot guarantee contrast. |

## 1. Engine: `clients/web/src/lib/color.ts`

Pure functions, no DOM, hex in and hex out (`#rrggbb`, lowercase).

- `isHex(s)`: `^#[0-9a-f]{6}$` (case-insensitive input, normalized lowercase).
- `toOklch(hex) → {l, c, h}` and `fromOklch({l, c, h}) → hex`. `fromOklch` brings out-of-gamut colors into sRGB by lowering chroma at fixed L and h (binary search), so hue never drifts.
- `contrast(a, b)`: WCAG 2.x relative luminance ratio.
- `fitLightness(color, against[], ratio, direction)`: steps L (binary search on the direction away from the `against` colors) until `contrast(result, x) ≥ ratio` for every `x`. Returns the input unchanged if it already passes. When the target cannot be reached in that direction it returns the end point (L = 0 or 1), which always passes against the dark surfaces this app uses.
- `labelOn(hex) → "#131313" | "#ffffff"`: whichever contrasts more.
- `readableAccent(hex, surfaces = [background, sidebar]) → {primary, primaryForeground}`: primary ≥ 3:1 on each surface (lighten); if neither label then reaches 4.5:1, keep lightening until the `#131313` label does (lightening never breaks the surface contrast, darkening could). The default surfaces are `#131313` and `#0d0d0d`. All six presets pass unchanged.
- `deriveTheme(seed, {ownAccent}) → Record<token, hex>`:
  - Surface hue = seed hue, surface chroma = `min(seed chroma, 0.05)`. Lightness ladder close to today's greys: sidebar 0.16, background 0.195, card/popover/topbar 0.235, muted/accent 0.29, secondary/border 0.37.
  - `--input`: ≥ 3:1 on background and card.
  - `--foreground` (and card/popover/secondary/accent/sidebar/topbar foregrounds): low chroma, ≥ 7:1 on every surface. `--muted-foreground`: ≥ 4.5:1 on every surface.
  - `--primary`, `--primary-foreground`, `--ring`: from `readableAccent(seed, [background, sidebar])` only when `ownAccent`; otherwise omitted so the server accent applies.
  - `--destructive` and `--mention` (hue 25), `--online` (hue 150), `--idle` (hue 80): fixed hues, fitted ≥ 3:1 on sidebar and card; their foregrounds via `labelOn` (≥ 4.5:1).
  - `--offline` left at the stylesheet value. Avatar and syntax colors untouched.

### Tests (`color.test.ts`)

- Conversions round-trip within 1/255 per channel for a sample of hexes.
- Presets: `readableAccent` returns each of the six unchanged.
- Known failures fixed: `#1a237e` (dark navy) and `#fff59d` (pale yellow) come back passing, same hue ±2°.
- Contrast guarantee sweep: for seeds across 24 hues × lightness {0.05, 0.3, 0.6, 0.95} × chroma {0, 0.1, 0.3}, plus `#000000` and `#ffffff`, and for both `ownAccent` values, every required pair meets its target: foreground ≥ 7 and muted-foreground ≥ 4.5 on each surface, input ≥ 3 on background and card, primary ≥ 3 on background and sidebar, primary-foreground ≥ 4.5 on primary, mention/destructive/online/idle ≥ 3 on sidebar and card, their foregrounds ≥ 4.5.
- Every output is a valid hex.

## 2. Server color: data and API

- Migration `server/internal/db/migrations/000NN_server_accent.sql` (next free number at implementation time; other sessions may also add migrations, so numbers can collide at merge):
  - Up: add `accent_color TEXT NOT NULL DEFAULT '#2ecc71' CHECK (accent_color ~ '^#[0-9a-f]{6}$')`; backfill from `palette` (emerald `#2ecc71`, ocean `#4aa3ff`, violet `#a78bfa`, amber `#f5a524`, rose `#fb7185`, mint `#2dd4bf`); drop `palette`.
  - Down: re-add `palette` with its old CHECK and default, set it from the exact preset hex or `emerald` otherwise, drop `accent_color`.
- `communities.Server` and `communities.ServerPreview`: `Palette` → `AccentColor string \`json:"accent_color" pattern:"^#[0-9a-f]{6}$"\``. Remove `Palettes`.
- `PATCH /api/server`: `palette` → `accent_color *string` (same pattern; the client sends lowercase). Audit diff key `accent_color`.
- The server does not check contrast; the client does.
- Regenerate `clients/core/src/schema.d.ts`; update Go tests (`communities_test.go`) and core tests that use `palette`.

## 3. Client: applying colors

- `lib/palettes.ts`: `PALETTES` becomes the preset list `{label, hex}` (same six). `ROLE_COLORS` unchanged.
- `hooks/use-palette.ts`: takes the server's `accent_color`, applies `readableAccent(hex)` to `--primary`, `--primary-foreground` and `--ring`. Skipped when the active theme sets its own accent (any built-in non-default theme, or a custom theme with `ownAccent`).
- Server preview on the auth pages (`use-server-preview.ts`, `AuthLayout.tsx`, `Register.tsx`) uses `accent_color`.
- `DesktopBridge` keeps reading tokens off the document; no change.

## 4. Client: user themes

- `theme/custom.ts`: `type CustomTheme = {id: string; name: string; seed: string; ownAccent: boolean}`. Store `datrope.customThemes` (list, max 12, names 1–32 chars trimmed, invalid entries dropped on load), with add, update, remove; cross-tab `storage` sync like `prefs.ts`.
- `theme/prefs.ts`: the theme pref is a built-in `ThemeId` or `custom:<id>`; an unknown custom id falls back to the default. Removing the active custom theme selects the default.
- `hooks/use-theme.ts`: for a custom theme, applies `deriveTheme(seed, {ownAccent})`.

## 5. UI

shadcn has no color picker or stepper; both are composed from registry primitives already in the repo (`Popover`, `Slider`, `Input`, `Dialog`, `Switch`, `DropdownMenu`, `Button`, `Progress` or plain step bars). No native `<input type="color">` (it opens the Windows dialog in the desktop app).

- `components/color-picker.tsx` `ColorPicker({value, onChange})`: saturation/value area (pointer and arrow-key operable, `role="slider"` with `aria-valuetext`), hue `Slider` ("Hue"), hex `Input` ("Hex") that commits only valid hex. Colors in the area and hue track are the subject color itself, the one place literal colors are drawn; chrome uses tokens.
- Server settings → Look ("Server color" section, replaces "Palette"):
  - Radio swatches for the six presets plus a "Custom" swatch that opens a `Popover` with `ColorPicker` and a "Use color" button.
  - When the engine adjusted the pick: "Picked [swatch hex] → Used [swatch hex]" row, no ratios. The used hex is saved on "Use color" (presets save on click, as now).
  - Existing preview stays, driven by the used hex.
- Settings → Appearance:
  - Built-in cards as now, then custom theme cards (thumbnail from the derived tokens, name, a `DropdownMenu` with Edit and Delete), then a "Create theme" card.
  - "Create theme" / Edit open a `Dialog` stepper with a three-segment step bar:
    1. Pick color: `ColorPicker`.
    2. Review palette: swatch ladder of the derived tokens (sidebar, background, card, hover, border, text, muted text, accent, mention, online; names and hex, no ratios), a live mini app preview, and a "Use my color for accents" `Switch`.
    3. Name: `Input` ("Theme name", prefilled "Custom N"), "Save theme". Saving selects the theme.
  - Delete asks for confirmation (`AlertDialog`).
  - At 12 custom themes, "Create theme" is disabled with a note.

## 6. Out of scope

Syncing themes across devices; light themes; deriving role colors; changing the six built-in Slack themes.

## 7. Verification

- `pnpm --filter web test` (engine sweep and existing tests), `go test ./internal/communities/...`, schema sync check.
- Browser preview: pick a preset and a custom dark navy in Look (adjusted chips shown, accent applies app-wide); create, edit, select and delete a custom theme with and without own accent; reload keeps it.
