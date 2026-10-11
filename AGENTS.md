# AGENTS.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Git

**Never commit. The user always makes commits.**

- Never run `git commit`, `git push`, or anything else that creates or publishes commits (including amend, rebase, merge commits, and tags).
- Staging changes or suggesting a commit message is fine when asked.

## 6. UI components (shadcn/ui + Tailwind v4)

**Fetch before you build.** The web client (`clients/web`) is built on shadcn/ui (style `new-york`, Radix) and Tailwind CSS v4. Config: `clients/web/components.json`.

- Before building any UI component, check the shadcn registry (https://ui.shadcn.com/docs/components) and add it with `pnpm dlx shadcn@latest add <name>` from `clients/web`. The shadcn agent skill in `.agents/skills/shadcn/` covers the CLI, registry and customization.
- Generated components live in `src/components/ui/`. Restyle through design tokens, cva variants, or `className`; don't fork Radix behaviour.
- Build a custom component only when nothing in the registry fits, and compose it from shadcn primitives. App-level pieces live in `src/components/` (`form-field`, `error-text`, `presence-dot`) and `src/hooks/` (`use-submit`); reuse them.
- Never hardcode colors. All tokens are CSS variables in `clients/web/src/styles.css` (`:root` + `@theme inline`); use the token utilities (`bg-background`, `bg-card`, `bg-sidebar`, `bg-primary`, `text-muted-foreground`, `border-border`, `bg-destructive`, `bg-online` / `bg-idle` / `bg-offline`, ...). New colors are added as tokens there first.
- The app is dark-only: no `.dark` class, no `dark:` variants, no theme toggle. Strip `dark:` classes from newly fetched components.
- Merge classes with `cn()` from `@/lib/utils`; import app code via the `@/` alias (`@/*` → `clients/web/src/*`).
- Local changes to generated components: `Button` defaults to `type="button"` (pass `type="submit"` explicitly), and its `destructive` variant uses `text-destructive-foreground`. Keep these when re-fetching `button`. `Slider` puts its `aria-label` on the thumb (the focusable `role="slider"`), not the root; keep that when re-fetching `slider`. `TooltipContent` defaults to `hideWhenDetached` (a tooltip whose trigger gets hidden, e.g. the message toolbar, must not stay open at the page's top-left); keep that when re-fetching `tooltip`.
- React is 18: generated components don't forward refs. Wrap a component in `React.forwardRef` before using it as an `asChild` child of a trigger that needs a ref (tooltip, popover, dropdown).
- Keep accessible names stable (labels, headings, button text); the Playwright e2e tests select by role and label.
- If the shadcn CLI fails on this machine (exFAT drive, `pnpm add` errors), fetch the component JSON from `https://ui.shadcn.com/r/styles/new-york-v4/<name>.json`, write its files into `src/components/ui/`, fix imports to `@/components/ui/*` and `@/lib/utils`, and add its dependencies to `package.json` by hand.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
