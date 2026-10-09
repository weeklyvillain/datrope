# shadcn Design System — Design

Date: 2026-10-09
Scope: `clients/web`

## Goal

Replace the hand-rolled CSS and `src/ui.tsx` kit with Tailwind CSS v4 + shadcn/ui
components, themed by a dark-only token set built from the project palette.
Make "fetch a shadcn component before building a custom one" a standing project rule.

## Decisions

- **Dark mode only.** `:root` holds the dark tokens; no `.dark` class, no toggle,
  no light theme. `color-scheme: dark`.
- **Full migration in one pass** (approach A). No period where the old CSS classes
  and Tailwind coexist. The app is small (~25 TSX files, 131 lines CSS).
- **No redesign of flows.** Layout and behaviour stay as they are; only the
  styling system and base components change.
- Font stays the system stack.

## 1. Tokens

Palette anchors (from the user): `#131313`, `#424242`, `#BDC3C7`, `#2ECC71`, `#E74C3C`.
Derived greys fill the gap between `#131313` and `#424242` so cards, hover and
borders stay distinguishable. Amber kept for the idle presence state.

| Token | Value | Source | Used for |
|---|---|---|---|
| `--sidebar` | `#0D0D0D` | derived | community rail |
| `--background` | `#131313` | palette | app background |
| `--card`, `--popover` | `#1C1C1C` | derived | channel sidebar, member list, dialogs, menus |
| `--muted`, `--accent` | `#2A2A2A` | derived | hover, selected row, code background |
| `--secondary`, `--border`, `--input` | `#424242` | palette | secondary buttons, lines, field borders |
| `--foreground` and every `--*-foreground` on greys | `#BDC3C7` | palette | text |
| `--muted-foreground` | `#969DA2` | derived | timestamps, hints (≥ 4.5:1 on `#2A2A2A`) |
| `--primary`, `--ring`, `--online` | `#2ECC71` | palette | main actions, links, focus ring, online dot |
| `--primary-foreground` | `#131313` | palette | text on green |
| `--destructive` | `#E74C3C` | palette | delete actions, errors |
| `--destructive-foreground` | `#131313` | palette | text on red (white fails AA at ~3.9:1) |
| `--idle` | `#D39B14` | kept | idle presence dot |
| `--offline` | `#6B7075` | derived | offline presence dot |
| `--radius` | `0.5rem` | kept (8px) | corner radius |

Tokens are declared as CSS variables in `src/styles.css` and mapped to Tailwind
colors with `@theme inline` (`bg-card`, `text-muted-foreground`, `bg-idle`, …).
Components and screens never hardcode hex values.

## 2. Tooling

- Dependencies: `tailwindcss`, `@tailwindcss/vite` (v4), `tw-animate-css`, plus
  whatever the shadcn CLI installs (`class-variance-authority`, `clsx`,
  `tailwind-merge`, `lucide-react`, Radix packages).
- `@/*` → `src/*` alias in `tsconfig.json` (`paths`) and `vite.config.ts` (`resolve.alias`),
  alongside the existing `@datrope/core` alias.
- `components.json`: style `new-york`, `tsx: true`, `rsc: false`, `cssVariables: true`,
  baseColor `neutral`, css `src/styles.css`, aliases `@/components`, `@/components/ui`,
  `@/lib`, `@/lib/utils`, `@/hooks`.
- `src/lib/utils.ts` exports `cn()`.
- Components are added with `pnpm dlx shadcn@latest add <name>` into
  `src/components/ui/`, only the ones screens use. Expected set: button, input,
  label, textarea, dialog, dropdown-menu, avatar, scroll-area, separator, tooltip;
  select / checkbox / switch if settings screens need them. Final list is settled
  during migration.
- Restyling happens through tokens first, then cva variants inside the generated
  file, then `className` at call sites. Radix behaviour is not forked.

Environment note: D: is exFAT (no symlinks, hoisted node-linker). If the shadcn CLI
cannot run here, components are fetched from the registry by hand with identical
output.

## 3. Migration

`src/ui.tsx` is deleted. Its exports move:

| Old | New |
|---|---|
| `Button` | shadcn `button` |
| `Field` | `src/components/form-field.tsx` composing `Label` + `Input` (+ hint) |
| `Modal` | shadcn `dialog` |
| `ErrorText` | `src/components/error-text.tsx` (one line, `text-destructive`) |
| `PresenceDot` | `src/components/presence-dot.tsx` (`bg-online` / `bg-idle` / `bg-offline`) |
| `useSubmit` | `src/hooks/use-submit.ts` |

Every file under `src/app` and `src/pages` is rewritten to Tailwind utilities and
the new components. `src/styles.css` ends up as: Tailwind + tw-animate imports,
token variables, `@theme inline` mapping, a small `@layer base` (body bg/text,
focus ring, headings).

## 4. Project rule

Add to root `CLAUDE.md` a section "## 6. UI components":

- Before building any UI component, check the shadcn registry and add it with
  `pnpm dlx shadcn@latest add <name>` (run in `clients/web`).
- Restyle via tokens, variants or `className`; don't fork Radix logic.
- Build a custom component only when nothing in the registry fits, and compose it
  from shadcn primitives where possible.
- Never hardcode colors; use the design tokens.

## 5. Verification

- `pnpm --filter @datrope/web typecheck` and `build` pass.
- Playwright e2e passes (selectors are role/label based; only one `input[type=file]`
  locator, unaffected).
- Visual check in the browser preview: login/register, community rail, channel
  view + composer, member list, each dialog, user/community/admin settings.
- Contrast spot-check of muted text and button labels.
- No leftover references to removed classes (`.btn`, `.field`, `.muted`, …).

## Out of scope

Light theme, theme toggle, custom fonts, layout or flow changes, Storybook.
