# shadcn Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `clients/web` from hand-rolled CSS + `src/ui.tsx` to Tailwind v4 + shadcn/ui components, themed by a dark-only token set.

**Architecture:** Tailwind v4 via `@tailwindcss/vite`; design tokens as CSS variables in `src/styles.css` mapped to Tailwind colors with `@theme inline`. shadcn components are fetched with the CLI into `src/components/ui/` and restyled through tokens/variants. During migration the old CSS lives in `@layer components` (variables renamed to the new tokens) so un-migrated screens keep rendering while Tailwind utilities win on migrated ones; the last task deletes it together with `src/ui.tsx`.

**Tech Stack:** React 18, Vite 5, TypeScript 5, Tailwind CSS v4, shadcn/ui (style `new-york`, Radix), class-variance-authority, tailwind-merge, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-09-shadcn-design-system-design.md`

## Global Constraints

- Dark mode only: tokens live on `:root`; no `.dark` class, no toggle, `color-scheme: dark`.
- Never hardcode hex colors in components or screens; use token utilities (`bg-card`, `text-muted-foreground`, `bg-idle`, ...). Hex values appear only in `src/styles.css`.
- No layout or flow changes. Visible text, `aria-*` labels, headings and roles stay identical. Playwright selects by role/label: labels "Name", "Invite link", "Message", "Username", "Password"; headings "# general", "Create the admin account", "Join ..."; buttons "Create", "Create a community", "Invite", "Done", "Send", "Create account"; one `input[type="file"]` locator.
- Font stays the system stack; root font size stays 15px.
- Never `git commit`. Finish each task with `git add` of its files (the user commits).
- Environment: D: is exFAT (no symlinks; root `.npmrc` has `node-linker=hoisted`). Write/Edit tools may be blocked on project files; write via the scratchpad + `cp` if so. Go dev server runs on :8081 (`DATROPE_DEV_SERVER=localhost:8081`); never touch port 8080.
- The web client has no unit-test runner and this is a styling migration, so per-task verification is `pnpm typecheck` and `pnpm build` (in `clients/web`) plus `pnpm lint` (repo root). End-to-end and visual checks run in the final task.

## Reference: class -> replacement map

Used by Tasks 3-7. Combine conditional classes with `cn()` from `@/lib/utils`.

| Old class | Replacement |
|---|---|
| `muted` | `text-muted-foreground` |
| `center` | `grid min-h-full place-items-center p-8 text-center` |
| `row` | `flex flex-wrap items-center gap-2` |
| `error` (`<p>`) | `<ErrorText error={...} />` |
| `card` | `<Card className="gap-3 p-4">` (`@/components/ui/card`) |
| `page` | `grid max-w-[860px] flex-1 content-start gap-6 overflow-y-auto p-6` |
| `table` | `Table` / `TableHeader` / `TableBody` / `TableRow` / `TableHead` / `TableCell` (`@/components/ui/table`) |
| `perm-grid` | `grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5` |
| `field` (label wrapping a `<select>`) | `<Field><FieldLabel htmlFor={id}>...</FieldLabel><NativeSelect id={id} ...>` |
| `auth` | `grid min-h-screen place-items-center p-4` |
| `auth-card` | `<Card className="w-full max-w-[400px] gap-4 p-6">`; its `h1` gets `text-xl`; its submit button `w-full` |
| `shell` | `flex h-screen overflow-hidden` |
| `rail` | `flex w-[68px] flex-none flex-col items-center gap-2 overflow-y-auto bg-sidebar py-2.5` |
| `rail-item` | `grid size-[46px] place-items-center rounded-[14px] bg-card font-semibold text-foreground no-underline`; `active` adds `bg-primary text-primary-foreground` |
| `rail-spacer` | `flex-1` |
| `sidebar` | `flex w-[236px] flex-none flex-col border-r bg-card max-[760px]:w-[190px]` |
| `sidebar-header` | `flex items-center justify-between gap-2 border-b p-3`; its `h1` gets `truncate` |
| `channel-list` | `flex-1 list-none overflow-y-auto p-2` |
| `channel-row` | `flex items-center` |
| `channel` | `block flex-1 rounded-md px-2 py-1.5 text-muted-foreground no-underline hover:bg-accent`; `active` -> `bg-accent text-foreground`; `unread` -> `font-semibold text-foreground`; `disabled` -> `cursor-default opacity-70` |
| `icon-btn` | `<Button variant="ghost" size="icon-sm">` (keep `aria-label` / `title`) |
| `main` | `flex min-w-0 flex-1 flex-col bg-background` |
| `main-header` | `border-b bg-card px-4 py-3` |
| `messages` | `flex flex-1 flex-col gap-0.5 overflow-y-auto p-4` |
| `msg` | `group relative rounded-md px-2 py-0.5 hover:bg-accent`; not `grouped` -> `mt-2.5`; `pending` -> body gets `opacity-60` |
| `msg header time` | `ml-1.5 text-xs text-muted-foreground` |
| `msg-body` | `m-0 whitespace-pre-wrap wrap-anywhere` |
| `msg-actions` | `absolute right-2 top-0.5 hidden gap-1 group-hover:flex group-focus-within:flex` |
| `typing` | `min-h-[1.4rem] px-4 text-sm text-muted-foreground` |
| `composer` | `flex flex-wrap items-end gap-2 px-4 pb-4`; its `<textarea>` -> `<Textarea className="max-h-[40vh] min-h-[2.6rem] flex-1 resize-none">` |
| `members` | `w-[220px] flex-none overflow-y-auto border-l bg-card p-3 max-[760px]:hidden`; its `ul` -> `mt-2 list-none`; its `li` -> `flex items-center gap-2 py-1` |
| `banner` | `fixed bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-foreground px-3.5 py-1.5 text-background` |
| `attachments` | `mt-1 flex flex-wrap gap-2` |
| `attachment-img` | `block h-auto max-w-full rounded-lg border bg-card` |
| `attachment-file` | `inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-foreground no-underline` |
| `chips` | `flex w-full list-none flex-wrap gap-1.5` |
| `chip` | `inline-flex items-center gap-1.5 rounded-full border bg-card py-0.5 pl-2.5 pr-1 text-sm`; `chip-error` -> `border-destructive` |
| `btn btn-primary` (raw `<button>`) | `<Button>` (keep `type`) |
| `btn btn-ghost` (raw `<button>`) | `<Button variant="outline">` (keep `type`) |

| Old (`ui.tsx`) | New |
|---|---|
| `Button` variant `primary` / `ghost` / `danger` | `Button` from `@/components/ui/button`, variant `default` (omit) / `outline` / `destructive` |
| `Field` | `FormField` from `@/components/form-field` (same props) |
| `ErrorText` | `@/components/error-text` |
| `PresenceDot` | `@/components/presence-dot` |
| `useSubmit` | `@/hooks/use-submit` |
| `Modal title onClose` | `Dialog` (pattern in Task 6) |
| `<input type="checkbox" checked onChange={(e) => f(e.target.checked)}>` | `<Checkbox checked onCheckedChange={(v) => f(v === true)}>` |
| `<input type="radio">` group | `RadioGroup` + `RadioGroupItem` + `Label` |
| `<select>` / `<option>` | `NativeSelect` / `NativeSelectOption` (`@/components/ui/native-select`) |

Forms that contain `FormField`s get `className="grid gap-3"` on the `<form>` (old `.field` had a bottom margin; shadcn `Field` has none).

---

### Task 1: Tailwind, tokens, alias, project rule

**Files:**
- Modify: `clients/web/package.json` (deps via pnpm), `pnpm-lock.yaml`
- Modify: `clients/web/vite.config.ts`
- Modify: `clients/web/tsconfig.json`
- Modify: `clients/web/src/styles.css`
- Create: `clients/web/src/lib/utils.ts`
- Create: `clients/web/components.json`
- Modify: `CLAUDE.md` (repo root)

**Interfaces:**
- Produces: `cn(...inputs: ClassValue[]): string` in `@/lib/utils`; `@/*` import alias; Tailwind color utilities `background foreground card card-foreground popover popover-foreground primary primary-foreground secondary secondary-foreground muted muted-foreground accent accent-foreground destructive destructive-foreground border input ring sidebar sidebar-foreground online idle offline`; radii `rounded-sm|md|lg|xl`.

- [ ] **Step 1: Install dependencies**

Run in `clients/web`:
```bash
pnpm add -D tailwindcss @tailwindcss/vite tw-animate-css
```
```bash
pnpm add clsx tailwind-merge class-variance-authority lucide-react
```
Expected: both succeed; `package.json` lists the packages.

- [ ] **Step 2: Vite plugin + alias**

`clients/web/vite.config.ts` (keep the existing comment and `server` const unchanged):
```ts
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@datrope/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // server block unchanged
});
```

- [ ] **Step 3: tsconfig path**

`clients/web/tsconfig.json` `paths` becomes:
```json
"paths": {
  "@datrope/core": ["../core/src/index.ts"],
  "@/*": ["./src/*"]
}
```

- [ ] **Step 4: `src/lib/utils.ts`**

```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 5: `components.json`**

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/styles.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

- [ ] **Step 6: Rewrite the top of `src/styles.css`**

Replace everything from the top of the file through the end of the `.btn:focus-visible, a:focus-visible, ...` rule (old `:root`, dark `@media`, `*`, `body`, `h1-h3`, `a`, `.muted`, `.center`, `.error`, `.btn*`, focus rule) with:

```css
@import "tailwindcss";
@import "tw-animate-css";

:root {
  color-scheme: dark;
  font-size: 15px;
  --radius: 0.5rem;
  --background: #131313;
  --foreground: #bdc3c7;
  --card: #1c1c1c;
  --card-foreground: #bdc3c7;
  --popover: #1c1c1c;
  --popover-foreground: #bdc3c7;
  --primary: #2ecc71;
  --primary-foreground: #131313;
  --secondary: #424242;
  --secondary-foreground: #bdc3c7;
  --muted: #2a2a2a;
  --muted-foreground: #969da2;
  --accent: #2a2a2a;
  --accent-foreground: #bdc3c7;
  --destructive: #e74c3c;
  --destructive-foreground: #131313;
  --border: #424242;
  --input: #424242;
  --ring: #2ecc71;
  --sidebar: #0d0d0d;
  --sidebar-foreground: #bdc3c7;
  --online: #2ecc71;
  --idle: #d39b14;
  --offline: #6b7075;
}

@theme inline {
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-online: var(--online);
  --color-idle: var(--idle);
  --color-offline: var(--offline);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}

@layer base {
  * { @apply border-border outline-ring/50; }
  body { @apply bg-background font-sans text-foreground; line-height: 1.45; }
  h1, h2, h3 { @apply font-semibold; }
  h1 { font-size: 1rem; }
  h2 { font-size: 1.05rem; }
  h3 { @apply text-muted-foreground uppercase; font-size: 0.8rem; letter-spacing: 0.04em; }
  a { @apply text-primary; }
  a:focus-visible { @apply outline-2 outline-offset-2 outline-ring; }
}
```

- [ ] **Step 7: Fence the legacy CSS**

Wrap everything remaining below the new block (from `.field { ... }` to end of file) in `@layer components { ... }`. Inside that block rename variables in this order (order matters, `--accent` is reused):

| From | To |
|---|---|
| `var(--accent-text)` | `var(--primary-foreground)` |
| `var(--accent)` | `var(--primary)` |
| `var(--hover)` | `var(--accent)` |
| `var(--muted)` | `var(--muted-foreground)` |
| `var(--panel)` | `var(--card)` |
| `var(--bg)` | `var(--background)` |
| `var(--rail)` | `var(--sidebar)` |
| `var(--text)` | `var(--foreground)` |
| `var(--danger)` | `var(--destructive)` |

Also re-add, inside the same layer, the helpers removed in Step 6 so un-migrated screens keep working:
```css
.muted { color: var(--muted-foreground); }
.center { display: grid; place-items: center; text-align: center; min-height: 100%; padding: 2rem; }
.error { color: var(--destructive); margin: 0.25rem 0; }
.btn { border: 1px solid transparent; border-radius: var(--radius); padding: 0.45rem 0.9rem; font: inherit; cursor: pointer; }
.btn:disabled { opacity: 0.6; cursor: default; }
.btn-primary { background: var(--primary); color: var(--primary-foreground); }
.btn-ghost { background: transparent; color: var(--foreground); border-color: var(--border); }
.btn-danger { background: var(--destructive); color: var(--destructive-foreground); }
```
All of this is deleted again in Task 8.

Verify: `grep -nE 'var\(--(panel|bg|rail|text|hover|danger|accent-text)\)' src/styles.css` -> no output.

- [ ] **Step 8: Project rule in root `CLAUDE.md`**

Insert before the closing `---` line:
```markdown
## 6. UI components

**Fetch before you build.** The web client (`clients/web`) uses shadcn/ui on Tailwind v4.

- Before building any UI component, check the shadcn registry (https://ui.shadcn.com/docs/components) and add it with `pnpm dlx shadcn@latest add <name>` from `clients/web`.
- Restyle through design tokens (`src/styles.css`), cva variants, or `className`; don't fork Radix behaviour.
- Build a custom component only when nothing in the registry fits, and compose it from shadcn primitives.
- Never hardcode colors; use the token utilities (`bg-card`, `text-muted-foreground`, `bg-idle`, ...). The app is dark-only.
```

- [ ] **Step 9: Verify**

In `clients/web`: `pnpm typecheck` -> exit 0; `pnpm build` -> exit 0, and `grep -l -- "--color-primary" dist/assets/*.css` finds the stylesheet. Root: `pnpm lint` -> exit 0.

- [ ] **Step 10: Stage**

```bash
git add clients/web/package.json pnpm-lock.yaml clients/web/vite.config.ts clients/web/tsconfig.json clients/web/src/styles.css clients/web/src/lib/utils.ts clients/web/components.json CLAUDE.md
```

---

### Task 2: Fetch shadcn components + shared app components

**Files:**
- Create (CLI): `clients/web/src/components/ui/{button,input,label,textarea,dialog,native-select,checkbox,radio-group,table,card,tabs,field,separator}.tsx` (`separator` is a `field` dependency)
- Create: `clients/web/src/components/form-field.tsx`
- Create: `clients/web/src/components/error-text.tsx`
- Create: `clients/web/src/components/presence-dot.tsx`
- Create: `clients/web/src/hooks/use-submit.ts`

**Interfaces:**
- Consumes: `cn` (Task 1); `errorText` from `src/session.ts`.
- Produces:
  - `Button` with `variant: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link"`, `size` incl. `"icon-sm"`, default `type="button"`.
  - `FormField(props: React.ComponentProps<"input"> & { label: string; hint?: string })`
  - `ErrorText({ error }: { error?: string })`
  - `PresenceDot({ status }: { status?: string })`
  - `useSubmit(): { busy: boolean; error: string | undefined; run: (fn: () => Promise<void>) => Promise<void> }`
  - shadcn exports as generated: `Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter`; `Field, FieldLabel, FieldDescription`; `NativeSelect, NativeSelectOption`; `Checkbox`; `RadioGroup, RadioGroupItem`; `Table, TableHeader, TableBody, TableRow, TableHead, TableCell`; `Card`; `Tabs, TabsList, TabsTrigger, TabsContent`; `Label`; `Input`; `Textarea`.

- [ ] **Step 1: Fetch**

Run in `clients/web`:
```bash
pnpm dlx shadcn@latest add button input label textarea dialog native-select checkbox radio-group table card tabs field separator
```
Expected: files appear in `src/components/ui/`; Radix deps added to `package.json`. Then `git diff src/styles.css`: if the CLI added or changed variables, revert those hunks (Task 1 owns the tokens).

Fallback if the CLI fails here (exFAT/symlink errors): for each name download `https://ui.shadcn.com/r/styles/new-york-v4/<name>.json`, write each `files[].content` to `src/components/ui/<name>.tsx`, rewrite `@/registry/new-york-v4/ui/` imports to `@/components/ui/`, and `pnpm add` its `dependencies`. If `native-select` or `field` is missing from the registry, stop and report; do not hand-write substitutes without asking.

- [ ] **Step 2: Restyle `button.tsx`**

In `buttonVariants`:
- `destructive` -> `"bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/40"` (generated `text-white` fails AA on `#E74C3C`).
- Confirm `size` has `icon-sm`; if absent add `"icon-sm": "size-8"`.

In `Button`, default the HTML type so buttons inside forms don't submit (old `ui.tsx` behaviour that the dialogs' Cancel buttons rely on): destructure `type` from props and pass `type={asChild ? type : (type ?? "button")}` to `Comp`.

- [ ] **Step 3: Strip dead `dark:` variants**

Generated files contain `dark:` classes that never apply (no `.dark` class in this app). Remove them:
```bash
grep -rln "dark:" src/components/ui | xargs sed -i -E 's/ ?dark:[^ "`]+//g'
```
Then `git diff --stat src/components/ui` and read `input.tsx`, `button.tsx`, `checkbox.tsx` to confirm class strings are intact.

- [ ] **Step 4: `src/components/form-field.tsx`**

```tsx
import { useId, type ComponentProps } from "react";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export function FormField({ label, hint, ...props }: ComponentProps<"input"> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} {...props} />
      {hint && <FieldDescription>{hint}</FieldDescription>}
    </Field>
  );
}
```

- [ ] **Step 5: `src/components/error-text.tsx`**

```tsx
export function ErrorText({ error }: { error?: string }) {
  return error ? <p className="my-1 text-destructive" role="alert">{error}</p> : null;
}
```

- [ ] **Step 6: `src/components/presence-dot.tsx`**

```tsx
import { cn } from "@/lib/utils";

const colors: Record<string, string> = { online: "bg-online", idle: "bg-idle" };

export function PresenceDot({ status = "offline" }: { status?: string }) {
  return <span className={cn("size-[9px] flex-none rounded-full", colors[status] ?? "bg-offline")} role="img" aria-label={status} />;
}
```

- [ ] **Step 7: `src/hooks/use-submit.ts`**

```ts
import { useState } from "react";
import { errorText } from "@/session";

/** Runs an async action with busy and error state. */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}
```

- [ ] **Step 8: Verify** - `pnpm typecheck`, `pnpm build` (clients/web), `pnpm lint` (root) all exit 0. If lint flags generated files, fix minimally in that file.

- [ ] **Step 9: Stage**

```bash
git add clients/web/package.json pnpm-lock.yaml clients/web/src/components clients/web/src/hooks
```

---

### Task 3: Auth pages, Home, RequireSession, Invite

**Files:**
- Modify: `clients/web/src/pages/AuthLayout.tsx`, `pages/Login.tsx`, `pages/Register.tsx`, `pages/Invite.tsx`
- Modify: `clients/web/src/app/Home.tsx`, `app/RequireSession.tsx`

**Interfaces:**
- Consumes: `Button`, `Card`, `FormField`, `ErrorText`, `useSubmit`, `cn`.

- [ ] **Step 1: Migrate.** Replace `../ui` imports with the new modules and apply the class map:
  - `AuthLayout.tsx`: `auth` wrapper and `auth-card` -> `Card` as mapped.
  - `Login.tsx`, `Register.tsx`: `<form className="grid gap-3">`; `Field` -> `FormField`; submit button keeps `type="submit"` and its text, adds `className="w-full"`.
  - `Invite.tsx`: raw `btn btn-primary` / `btn btn-ghost` -> `Button` per map; heading "Join ..." unchanged; the "Create account" link stays a link.
  - `Home.tsx`: `variant="ghost"` -> `variant="outline"`; `Field` -> `FormField`.
  - `RequireSession.tsx`: `"center muted"` -> `"grid min-h-full place-items-center p-8 text-center text-muted-foreground"`.
- [ ] **Step 2: Verify** - `grep -nE 'from "\.\./ui"|className="(auth|auth-card|center|muted|row|btn)' src/pages src/app/Home.tsx src/app/RequireSession.tsx` -> no output. `pnpm typecheck`, `pnpm build`, root `pnpm lint` -> exit 0.
- [ ] **Step 3: Stage** - `git add clients/web/src/pages clients/web/src/app/Home.tsx clients/web/src/app/RequireSession.tsx`

---

### Task 4: App shell, rail, sidebars, member list

**Files:**
- Modify: `clients/web/src/app/AppShell.tsx`, `CommunityRail.tsx`, `ChannelSidebar.tsx`, `CommunityView.tsx`, `DMView.tsx`, `MemberList.tsx`

**Interfaces:**
- Consumes: `Button`, `PresenceDot`, `cn`.

- [ ] **Step 1: Migrate.** Apply the class map:
  - Template-literal classes (`` `rail-item ${...}` ``, `` `channel ${...}` ``) -> `cn(base, cond && extra)`.
  - `icon-btn` buttons -> `<Button variant="ghost" size="icon-sm">`, keep `aria-label`, `title`, children.
  - `variant="ghost"` -> `variant="outline"` ("Invite", "+ Add channel", "New").
  - `MemberList`: `PresenceDot` from `@/components/presence-dot`.
- [ ] **Step 2: Verify** - the six files import nothing from `../ui` and contain no class names from the map's left column. `pnpm typecheck`, `pnpm build`, root `pnpm lint` -> exit 0.
- [ ] **Step 3: Stage** - `git add` the six files.

---

### Task 5: Channel view, message list, composer

**Files:**
- Modify: `clients/web/src/app/ChannelView.tsx`, `MessageList.tsx`, `Composer.tsx`

**Interfaces:**
- Consumes: `Button`, `Textarea`, `ErrorText`, `cn`.

- [ ] **Step 1: Migrate.** Apply the class map:
  - `MessageList`: wrapper -> `cn("group relative rounded-md px-2 py-0.5 hover:bg-accent", !grouped && "mt-2.5")`; body -> `cn("m-0 whitespace-pre-wrap wrap-anywhere", pending && "opacity-60")` (`msg-body muted` adds `text-muted-foreground`); `msg-actions`, `<time>`, attachments per map; `<div ref={bottom} />` unchanged; ghost buttons ("Load older", "Cancel") -> `outline`.
  - `Composer`: `<textarea>` -> `Textarea` with identical props (`aria-label="Message"`, handlers, `value`, `rows`) plus the map's className; hidden `<input ref={picker} type="file" multiple hidden>` stays native; attach button -> `variant="outline"`, keeps `aria-label="Attach files"`; "Send" keeps `type="submit"`; chips per map.
  - `ChannelView`: `main`, `main-header`, `typing`, `center muted` per map; heading `# {name}` unchanged.
- [ ] **Step 2: Verify** - no map-left-column class names or `../ui` imports remain in the three files; `pnpm typecheck`, `pnpm build`, root `pnpm lint` -> exit 0.
- [ ] **Step 3: Stage** - `git add` the three files.

---

### Task 6: Dialogs

**Files:**
- Modify: `clients/web/src/app/dialogs/CreateCommunityDialog.tsx`, `CreateChannelDialog.tsx`, `InviteDialog.tsx`, `NewDMDialog.tsx`, `ChannelSettingsDialog.tsx`

**Interfaces:**
- Consumes: `Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter`, `Button`, `FormField`, `ErrorText`, `useSubmit`, `Checkbox`, `RadioGroup, RadioGroupItem`, `Label`, `Input`, `Field, FieldLabel`, `NativeSelect, NativeSelectOption`, `Tabs, TabsList, TabsTrigger, TabsContent`.

Parents mount dialogs conditionally (`{dialog && <X onClose={...} />}`), so each dialog is open whenever mounted:

```tsx
<Dialog open onOpenChange={(open) => !open && onClose()}>
  <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]">
    <DialogHeader>
      <DialogTitle>{title}</DialogTitle>
    </DialogHeader>
    {/* former Modal children */}
  </DialogContent>
</Dialog>
```
Radix handles Escape and overlay-click close (replaces the old `keydown` listener). If Radix logs a missing-description warning, add `aria-describedby={undefined}` to `DialogContent`.

- [ ] **Step 1: Migrate.** Convert each `Modal` with the pattern. Button rows (`row` with Cancel/Create) -> `DialogFooter`. `ghost` -> `outline`, `danger` -> `destructive`. Forms get `className="grid gap-3"`.
  - `CreateChannelDialog`: with `const id = useId();` replace the radio pair by
    ```tsx
    <RadioGroup value={type} onValueChange={(v) => setType(v as typeof type)} className="flex gap-4">
      <div className="flex items-center gap-2">
        <RadioGroupItem value="text" id={`${id}-text`} />
        <Label htmlFor={`${id}-text`}>Text</Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="voice" id={`${id}-voice`} />
        <Label htmlFor={`${id}-voice`}>Voice</Label>
      </div>
    </RadioGroup>
    ```
  - `NewDMDialog`: `<input type="checkbox" checked={picked.includes(u.id)} onChange={() => toggle(u.id)} />` -> `<Checkbox checked={picked.includes(u.id)} onCheckedChange={() => toggle(u.id)} />` inside the existing `<label>`, which gets `className="flex items-center gap-2"`.
  - `InviteDialog`: the read-only link input keeps accessible name "Invite link" (`FormField label="Invite link" readOnly ...`, or `Label` + `Input` with matching `id`); "Done" -> `variant="outline"`.
  - `ChannelSettingsDialog`: the two `role="tab"` buttons + conditional panels -> `<Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>` with `TabsList` > `TabsTrigger value="general"` / `value="permissions"` (same visible labels as today) and `TabsContent` around each panel. `<label className="field">` + `<select>` -> `Field` / `FieldLabel htmlFor` / `NativeSelect id`; per-permission `<select>` in the perm grid -> `NativeSelect` with `aria-label` equal to the permission label shown beside it.
- [ ] **Step 2: Verify** - `grep -rnE 'Modal|from "\.\./\.\./ui"' src/app/dialogs` -> no output. `pnpm typecheck`, `pnpm build`, root `pnpm lint` -> exit 0.
- [ ] **Step 3: Stage** - `git add clients/web/src/app/dialogs`

---

### Task 7: Settings pages

**Files:**
- Modify: `clients/web/src/app/settings/UserSettings.tsx`, `CommunitySettings.tsx`, `AdminSettings.tsx`

**Interfaces:**
- Consumes: `Card`, `Table*`, `Button`, `FormField`, `ErrorText`, `useSubmit`, `Checkbox`, `Field, FieldLabel`, `NativeSelect, NativeSelectOption`, `cn`.

- [ ] **Step 1: Migrate.** Apply the map:
  - `page` container; every `card` -> `<Card className="gap-3 p-4">`; every `table` -> shadcn `Table` family (same columns and header text).
  - `<label className="field">` + `<select>` (UserSettings presence, AdminSettings registration mode) -> `Field` / `FieldLabel htmlFor={id}` / `NativeSelect id={id} value onChange` / `NativeSelectOption`.
  - Checkboxes (CommunitySettings permission grid and member roles; AdminSettings "allow") -> `Checkbox` with `onCheckedChange={(v) => ... v === true ...}` replacing `e.target.checked`; keep `checked` and `disabled`; wrapping `<label>`s get `className="flex items-center gap-2"`.
  - Variant ternaries: `"primary" : "ghost"` -> `"default" : "outline"`; `"ghost" : "danger"` -> `"outline" : "destructive"`; `ghost` -> `outline`; `danger` -> `destructive`.
  - `window.confirm` flows unchanged.
- [ ] **Step 2: Verify** - `grep -rnE 'from "\.\./\.\./ui"|className="(page|card|table|field|perm-grid|row|muted)"' src/app/settings` -> no output. `pnpm typecheck`, `pnpm build`, root `pnpm lint` -> exit 0.
- [ ] **Step 3: Stage** - `git add clients/web/src/app/settings`

---

### Task 8: Remove legacy, full verification

**Files:**
- Delete: `clients/web/src/ui.tsx`
- Modify: `clients/web/src/styles.css` (delete the legacy `@layer components { ... }` block)

- [ ] **Step 1: Confirm nothing uses the old kit or classes**

```bash
grep -rnE 'from "(\.\./)*(\.\./|\./)ui"' clients/web/src
```
```bash
grep -rnoE 'className="[^"]*' clients/web/src/app clients/web/src/pages | grep -wE 'btn|btn-primary|btn-ghost|btn-danger|field|muted|center|row|card|page|table|rail|rail-item|rail-spacer|sidebar|sidebar-header|channel|channel-list|channel-row|icon-btn|main|main-header|messages|msg|msg-body|msg-actions|typing|composer|members|dot|overlay|modal|banner|auth|auth-card|perm-grid|attachments|attachment-img|attachment-file|chips|chip|chip-error'
```
Expected: no output from the first. The second may hit Tailwind tokens that share a word (`bg-card`, `bg-muted`); inspect every hit and only act on genuine legacy class names. Also check template literals / `cn(...)` strings by hand.

- [ ] **Step 2: Delete** `src/ui.tsx` and the legacy `@layer components` block. `styles.css` now contains only the imports, `:root`, `@theme inline`, `@layer base`.
- [ ] **Step 3: Static checks** - `pnpm typecheck`, `pnpm build` (clients/web); root `pnpm lint`, `pnpm typecheck` -> exit 0.
- [ ] **Step 4: Visual check** - start the Go server on :8081 and the web dev server (`.claude/launch.json` entry if present, otherwise create one running `pnpm dev` with `DATROPE_DEV_SERVER=localhost:8081`). In the browser pane check: register/login; community rail (active item green); channel sidebar (active / unread / hover); channel header, messages, hover actions, composer, attachment chip; member list dots (online green, idle amber, offline grey); each dialog (opens, Esc closes, overlay click closes, Cancel doesn't submit); user / community / admin settings incl. tabs, checkboxes, selects, tables. Console has no errors. Spot-check computed colors: muted text `rgb(150, 157, 162)`, destructive button text `rgb(19, 19, 19)`, body background `rgb(19, 19, 19)`.
- [ ] **Step 5: E2E** - if the e2e compose stack can run locally (`deploy/.env.e2e`), run `pnpm --filter @datrope/web e2e` -> all pass. If it cannot run here, say so explicitly; CI runs it.
- [ ] **Step 6: Stage** - `git add -A clients/web/src`
