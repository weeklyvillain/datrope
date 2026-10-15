# Animated Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every icon inside a button, link or menu item in the web client plays a short, one-shot "Spring" animation on mouse hover or keyboard focus.

**Architecture:** One file per icon in `clients/web/src/components/icons/`. Each renders a `motion` `m.svg` that is wired, through a shared `useIconControls` hook, to the hover and focus events of its nearest interactive ancestor. 56 icons are normalised from the lucide-animated registry and 66 are authored from shared motion presets. A barrel re-exports them under the lucide names so app code only changes its import line.

**Tech Stack:** React 18.3, TypeScript, `motion` v12 (`motion/react`, `LazyMotion` + `m`), Vitest (+ `happy-dom` for DOM tests), Tailwind v4, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-14-animated-icons-design.md`. Visual reference: `docs/superpowers/mockups/AnimatedIcons.html`, tab **B · Spring**. Open it in a browser to see the target motion.

## Global Constraints

- All paths below are relative to `clients/web/` unless they start with `docs/`.
- **Never commit.** No `git commit`, push, amend or tag (AGENTS.md §5). Each task ends with a checkpoint where the user commits.
- Import motion as `m` from `"motion/react"` only. Never `motion.*`: `LazyMotion strict` throws on it.
- Every `animate` variant ends at rest: x/y 0, rotate 0, scale/scaleX/scaleY 1, opacity 1. Spins of symmetric shapes may end at their angle only when they carry `transitionEnd: { rotate: 0 }`.
- Animation length: 400–700 ms per one-shot. Default ease is `[0.22, 1, 0.36, 1]` (the app's `--ease-out-quint`).
- Icon sizing: `size` defaults to `24`, `strokeWidth` to `2`. The svg carries the class `cn("lucide lucide-<kebab-name>", className)` and `aria-hidden="true"` unless the caller passes `aria-label`.
- No hardcoded colors; icons draw with `stroke="currentColor"`.
- Don't touch `src/components/ui/*` or `src/lib/brand-icons.tsx`.
- Accessible names (labels, button text) must not change; Playwright e2e selects by role and label.
- Static icons that stay on `lucide-react`: `Loader2`, `Circle`, `Square`, `SignalHigh`, `SignalLow`, `SignalMedium`, `SignalZero`.
- Status: this worktree has no `node_modules`; Task 1 installs them.

## Review Focus

1. **Pointer leaves mid-animation** → the icon eases back to rest, with no stuck transform and no backward spin. Test: `icons.test.tsx`, "stop right after start rests every icon" (Task 3).
2. **Touch tap on phone** → no animation. Test: `icon-base.test.tsx`, "ignores touch pointers" (Task 2).
3. **Mouse click focuses the button** → it must not play a second time from `focusin`. Test: `icon-base.test.tsx`, "focus without focus-visible does nothing" (Task 2).
4. **Reduced motion** → `MotionConfig` snaps animations to their end state, so every end state must be rest. Test: `icons.test.tsx`, "every icon rests after its animation" (Task 3, extended in Tasks 4–7).
5. **Icon used outside any control** (heading, label, list row) → no listeners, never moves. Test: `icon-base.test.tsx`, "no interactive ancestor → no-op" (Task 2).

---

### Task 1: Dependencies, baseline size, root providers

**Files:**
- Modify: `package.json` (add `motion`, dev `happy-dom`)
- Modify: `src/main.tsx`

**Interfaces:**
- Produces: `LazyMotion features={domAnimation} strict` + `MotionConfig reducedMotion="user"` around the whole app. Later tasks rely on `m.*` working at runtime.

- [ ] **Step 1: Install and record the baseline bundle**

```bash
cd clients/web
rtk pnpm install
rtk pnpm build
```

Copy the `dist/assets/index-*.js` line (raw and gzip size) from the Vite output into a note. You'll compare against it in Task 9. Expected: the build succeeds.

- [ ] **Step 2: Add dependencies**

```bash
rtk pnpm add motion@^12
rtk pnpm add -D happy-dom
```

Expected: `package.json` lists `"motion": "^12…"` under `dependencies` and `"happy-dom"` under `devDependencies`.

- [ ] **Step 3: Wrap the app in motion providers** (`src/main.tsx`)

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { LazyMotion, MotionConfig, domAnimation } from "motion/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { router } from "./router";
import "./sounds";
import "./styles.css";
import { registerServiceWorker } from "./sw-register";

registerServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </MotionConfig>
    </LazyMotion>
  </StrictMode>,
);
```

- [ ] **Step 4: Verify**

Run: `rtk pnpm typecheck && rtk vitest run`
Expected: both pass. Nothing visible changes yet.

- [ ] **Step 5: Checkpoint.** Tell the user the task is done and ready to commit. Don't commit yourself.

---

### Task 2: Icon base (types, hover binding, svg shell)

**Files:**
- Create: `src/components/icons/icon-base.tsx`
- Test: `src/components/icons/icon-base.test.tsx`

**Interfaces:**
- Produces:
  - `type AnimatedIconProps = Omit<ComponentPropsWithoutRef<"svg">, "onAnimationStart" | "onAnimationEnd" | "onAnimationIteration" | "onDrag" | "onDragStart" | "onDragEnd"> & { size?: number | string; strokeWidth?: number | string }`
  - `type AnimatedIcon = ComponentType<AnimatedIconProps>`
  - `INTERACTIVE: string` (the `closest()` selector)
  - `bindIconHover(icon: Element, start: () => void, stop: () => void): () => void`
  - `useIconControls(forwarded: ForwardedRef<SVGSVGElement>): { ref: (el: SVGSVGElement | null) => void; controls: IconControls }`, where `type IconControls = ReturnType<typeof useAnimation>`
  - `IconSvg`: a `forwardRef<SVGSVGElement, AnimatedIconProps & { name: string; animate?: IconControls; variants?: Variants; children: ReactNode }>` that renders `m.svg` with the lucide defaults.

- [ ] **Step 1: Write the failing test** (`src/components/icons/icon-base.test.tsx`)

```tsx
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindIconHover } from "./icon-base";

const pointer = (type: string, pointerType: string) => new PointerEvent(type, { pointerType, bubbles: false });

function setup(html: string) {
  document.body.innerHTML = html;
  const icon = document.querySelector("svg")!;
  const start = vi.fn();
  const stop = vi.fn();
  const cleanup = bindIconHover(icon, start, stop);
  return { icon, start, stop, cleanup, host: icon.closest("button, a, [role]") as HTMLElement | null };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("bindIconHover", () => {
  it("starts on mouse enter of the parent button and stops on leave", () => {
    const { host, start, stop } = setup(`<button><svg></svg></button>`);
    host!.dispatchEvent(pointer("pointerenter", "mouse"));
    expect(start).toHaveBeenCalledTimes(1);
    host!.dispatchEvent(pointer("pointerleave", "mouse"));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("works for links and menu items", () => {
    for (const html of [`<a href="/x"><svg></svg></a>`, `<div role="menuitem"><svg></svg></div>`, `<div role="tab"><svg></svg></div>`]) {
      const { host, start } = setup(html);
      host!.dispatchEvent(pointer("pointerenter", "pen"));
      expect(start).toHaveBeenCalledTimes(1);
    }
  });

  it("ignores touch pointers", () => {
    const { host, start } = setup(`<button><svg></svg></button>`);
    host!.dispatchEvent(pointer("pointerenter", "touch"));
    expect(start).not.toHaveBeenCalled();
  });

  it("starts on keyboard focus (focus-visible) and stops on blur", () => {
    const { host, start, stop } = setup(`<button><svg></svg></button>`);
    host!.matches = ((sel: string) => sel === ":focus-visible") as typeof host.matches;
    host!.dispatchEvent(new FocusEvent("focusin"));
    expect(start).toHaveBeenCalledTimes(1);
    host!.dispatchEvent(new FocusEvent("focusout"));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("focus without focus-visible does nothing", () => {
    const { host, start } = setup(`<button><svg></svg></button>`);
    host!.matches = (() => false) as typeof host.matches;
    host!.dispatchEvent(new FocusEvent("focusin"));
    expect(start).not.toHaveBeenCalled();
  });

  it("no interactive ancestor → no-op", () => {
    const { icon, start } = setup(`<h2><svg></svg></h2>`);
    icon.parentElement!.dispatchEvent(pointer("pointerenter", "mouse"));
    expect(start).not.toHaveBeenCalled();
  });

  it("cleanup removes the listeners", () => {
    const { host, start, cleanup } = setup(`<button><svg></svg></button>`);
    cleanup();
    host!.dispatchEvent(pointer("pointerenter", "mouse"));
    expect(start).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `rtk vitest run src/components/icons/icon-base.test.tsx`
Expected: FAIL. `Failed to resolve import "./icon-base"`.

- [ ] **Step 3: Implement** (`src/components/icons/icon-base.tsx`)

```tsx
import { m, useAnimation, type Variants } from "motion/react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
  type ComponentType,
  type ForwardedRef,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

export type AnimatedIconProps = Omit<
  ComponentPropsWithoutRef<"svg">,
  "onAnimationStart" | "onAnimationEnd" | "onAnimationIteration" | "onDrag" | "onDragStart" | "onDragEnd"
> & { size?: number | string; strokeWidth?: number | string };

/** Replaces lucide's `LucideIcon`; lucide components satisfy it too. */
export type AnimatedIcon = ComponentType<AnimatedIconProps>;

/** Controls whose hover/keyboard focus plays the icon inside them. */
export const INTERACTIVE = 'button, a[href], [role="button"], [role="menuitem"], [role="tab"], [role="option"], summary';

const keyboardFocused = (el: Element) => {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
};

/** Plays `start`/`stop` on hover (mouse, pen) and keyboard focus of the icon's nearest control. Returns cleanup. */
export function bindIconHover(icon: Element, start: () => void, stop: () => void): () => void {
  const host = icon.closest(INTERACTIVE);
  if (!host) return () => {};
  const enter = (e: Event) => {
    if ((e as PointerEvent).pointerType !== "touch") start();
  };
  const leave = (e: Event) => {
    if ((e as PointerEvent).pointerType !== "touch") stop();
  };
  const focusIn = () => {
    if (keyboardFocused(host)) start();
  };
  host.addEventListener("pointerenter", enter);
  host.addEventListener("pointerleave", leave);
  host.addEventListener("focusin", focusIn);
  host.addEventListener("focusout", stop);
  return () => {
    host.removeEventListener("pointerenter", enter);
    host.removeEventListener("pointerleave", leave);
    host.removeEventListener("focusin", focusIn);
    host.removeEventListener("focusout", stop);
  };
}

/** Animation controls for one icon, played by its nearest control's hover and keyboard focus. */
export function useIconControls(forwarded: ForwardedRef<SVGSVGElement>) {
  const controls = useAnimation();
  const [el, setEl] = useState<SVGSVGElement | null>(null);
  const ref = useCallback(
    (node: SVGSVGElement | null) => {
      setEl(node);
      if (typeof forwarded === "function") forwarded(node);
      else if (forwarded) forwarded.current = node;
    },
    [forwarded],
  );
  useEffect(() => {
    if (!el) return;
    return bindIconHover(
      el,
      () => void controls.start("animate"),
      () => void controls.start("normal"),
    );
  }, [el, controls]);
  return { ref, controls };
}

/** motion v12 names this LegacyAnimationControls; derive it so the import can't drift. */
export type IconControls = ReturnType<typeof useAnimation>;

type IconSvgProps = AnimatedIconProps & { name: string; animate?: IconControls; variants?: Variants; children: ReactNode };

/** The lucide-shaped `<svg>` every animated icon renders. */
export const IconSvg = forwardRef<SVGSVGElement, IconSvgProps>(
  ({ name, size = 24, strokeWidth = 2, className, animate, variants, children, ...props }, ref) => (
    <m.svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={props["aria-label"] ? undefined : true}
      className={cn("lucide", `lucide-${name}`, className)}
      initial="normal"
      animate={animate}
      variants={variants}
      {...props}
    >
      {children}
    </m.svg>
  ),
);
IconSvg.displayName = "IconSvg";
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `rtk vitest run src/components/icons/icon-base.test.tsx`
Expected: PASS, 7 tests. If happy-dom lacks `PointerEvent`, replace `new PointerEvent(...)` in the test with `Object.assign(new Event(type), { pointerType })`.

- [ ] **Step 5: Typecheck**

Run: `rtk pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Checkpoint.** Ready for the user to commit.

---

### Task 3: Motion presets, barrel, first two icons, behaviour tests

The pipeline gets proven end to end on one registry icon (`settings`) and one authored icon (`trash-2`) before the bulk work.

**Files:**
- Create: `src/components/icons/motions.ts`
- Create: `src/components/icons/settings.tsx`
- Create: `src/components/icons/trash-2.tsx`
- Create: `src/components/icons/index.ts`
- Test: `src/components/icons/icons.test.tsx`

**Interfaces:**
- Consumes: `IconSvg`, `useIconControls`, `AnimatedIconProps`, `AnimatedIcon` from `./icon-base`.
- Produces:
  - `motions.ts` exports `EASE`, `variants(animate, transition?)`, `pop`, `shake`, `ring`, `hop`, `tilt`, `drop`, `lift`, `scribble`, `nudge(x, y?)`, `spin(deg)`, `blink(delay?)`, `bounce(delay?, axis?)`, `fly(x)` and `squash(axis)`, all returning `Variants` with `normal` and `animate` keys.
  - Icon component naming: the PascalCase lucide name (`Settings`, `Trash2`) exported from `./<kebab-name>.tsx`.
  - Barrel: `index.ts` re-exports every icon plus `type AnimatedIcon, type AnimatedIconProps`.

- [ ] **Step 1: Write the failing test** (`src/components/icons/icons.test.tsx`)

```tsx
// @vitest-environment happy-dom
import { MotionGlobalConfig } from "motion/react";
import { act, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnimatedIconProps } from "./icon-base";

// Every icon file except the base. Each exports exactly one component.
const files = import.meta.glob<Record<string, ComponentType<AnimatedIconProps>>>(["./*.tsx", "!./icon-base.tsx", "!./*.test.tsx"], { eager: true });
const icons = Object.entries(files).map(([path, mod]) => {
  const [name, Icon] = Object.entries(mod)[0];
  return { kebab: path.slice(2, -4), name, Icon };
});

const rested = (el: Element) => {
  const s = (el as SVGElement).style;
  return (s.transform === "" || s.transform === "none") && (s.opacity === "" || s.opacity === "1");
};

const tick = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

describe("animated icons", () => {
  beforeAll(() => {
    MotionGlobalConfig.instantAnimations = true;
  });
  afterAll(() => {
    MotionGlobalConfig.instantAnimations = false;
  });

  it("found icon files", () => {
    expect(icons.length).toBeGreaterThan(0);
  });

  it.each(icons)("$kebab renders a lucide-shaped, hidden svg with the passed class", ({ kebab, Icon }) => {
    const out = renderToStaticMarkup(<Icon className="size-5 text-primary" />);
    expect(out).toMatch(/^<svg/);
    expect(out).toContain(`lucide-${kebab}`);
    expect(out).toContain("size-5 text-primary");
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain('width="24"');
  });

  it.each(icons)("$kebab rests after its animation", async ({ Icon }) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<button type="button"><Icon /></button>));
    const button = host.querySelector("button")!;
    button.dispatchEvent(Object.assign(new Event("pointerenter"), { pointerType: "mouse" }));
    await tick(50);
    for (const el of host.querySelectorAll("svg, svg *")) expect(rested(el)).toBe(true);
    await act(async () => root.unmount());
    host.remove();
  });

  it.each(icons)("$kebab: stop right after start rests every icon", async ({ Icon }) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<button type="button"><Icon /></button>));
    const button = host.querySelector("button")!;
    button.dispatchEvent(Object.assign(new Event("pointerenter"), { pointerType: "mouse" }));
    button.dispatchEvent(Object.assign(new Event("pointerleave"), { pointerType: "mouse" }));
    await tick(50);
    for (const el of host.querySelectorAll("svg, svg *")) expect(rested(el)).toBe(true);
    await act(async () => root.unmount());
    host.remove();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `rtk vitest run src/components/icons/icons.test.tsx`
Expected: FAIL on "found icon files" (`expected 0 to be greater than 0`).

- [ ] **Step 3: Write the presets** (`src/components/icons/motions.ts`)

```ts
import type { TargetAndTransition, Transition, Variants } from "motion/react";

/** The app's --ease-out-quint. */
export const EASE = [0.22, 1, 0.36, 1] as const;

const REST = { x: 0, y: 0, rotate: 0, scale: 1, scaleX: 1, scaleY: 1, opacity: 1 };

/** `normal` eases back to rest; `animate` is a one-shot that must end at rest. */
export const variants = (animate: TargetAndTransition, transition: Transition = {}): Variants => ({
  normal: { ...REST, transition: { duration: 0.2, ease: EASE } },
  animate: { ...animate, transition: { duration: 0.6, ease: EASE, ...transition } },
});

export const pop = variants({ scale: [1, 0.8, 1.18, 1] });
export const shake = variants({ rotate: [0, -12, 10, -5, 0] });
/** Swing from the top: pair with style={{ originY: 0 }}. */
export const ring = variants({ rotate: [0, 18, -16, 10, -6, 0] });
export const hop = variants({ y: [0, -3, 0, -2, 0], rotate: [0, -8, 0, 6, 0] });
export const tilt = variants({ rotate: [0, -14, 8, 0], scale: [1, 1.1, 1.1, 1] });
export const drop = variants({ y: [-5, 1.5, -0.5, 0], opacity: [0.3, 1, 1, 1] });
/** Lid lift: pair with style={{ originX: 0, originY: 1 }}. */
export const lift = variants({ y: [0, -4, -1, 0], rotate: [0, -18, 4, 0] });
export const scribble = variants({ rotate: [0, -10, 6, -6, 0], x: [0, -1, 1, -1, 0], y: [0, 1, -1, 1, 0] });
export const nudge = (x: number, y = 0) => variants({ x: [0, x, 0], y: [0, y, 0] }, { duration: 0.45 });
/** Only for shapes symmetric under `deg`; snaps to 0 at the end so leaving never spins back. */
export const spin = (deg: number) => variants({ rotate: [0, deg * 1.1, deg], transitionEnd: { rotate: 0 } });
export const blink = (delay = 0) => variants({ opacity: [1, 0, 1] }, { delay, duration: 0.5 });
export const bounce = (delay = 0, axis: "x" | "y" = "y") => variants({ [axis]: [0, -4, 0] }, { delay, duration: 0.45 });
export const fly = (x: number) => variants({ x: [0, x, -x, 0], opacity: [1, 0, 0, 1] }, { times: [0, 0.45, 0.46, 1] });
export const squash = (axis: "scaleX" | "scaleY") => variants({ [axis]: [1, 0.7, 1.1, 1] });
```

- [ ] **Step 4: Fetch and normalise the registry `settings` icon**

Fetch the raw registry file to read its paths and motion. Save it to the session scratchpad, not the repo:

```bash
curl -sL https://lucide-animated.com/r/settings.json | python -c "import json,sys;print(json.load(sys.stdin)['files'][0]['content'])"
```

The registry original wraps a `<div>` with mouse handlers, `motion.svg`, `size = 28` and an imperative handle, and rotates to 180 on hover. Normalised (`src/components/icons/settings.tsx`):

```tsx
import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { spin } from "./motions";

export const Settings = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="settings" animate={controls} variants={spin(180)} {...props}>
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
      <m.circle cx="12" cy="12" r="3" />
    </IconSvg>
  );
});
Settings.displayName = "Settings";
```

Use the path data from the **installed** `lucide-react` (`node_modules/lucide-react/dist/esm/icons/settings.js`, the `__iconNode` array), not the registry. That way the static look matches what the app shows today. If the installed lucide path differs from the one above, use the installed one. Elements that don't animate stay plain (`<path>`); only animated parts need `m.*`. (`m.circle` above is harmless, and `<circle>` is equally fine.)

- [ ] **Step 5: Author `trash-2`** (`src/components/icons/trash-2.tsx`)

```tsx
import { m } from "motion/react";
import { forwardRef } from "react";
import { IconSvg, useIconControls, type AnimatedIconProps } from "./icon-base";
import { lift } from "./motions";

export const Trash2 = forwardRef<SVGSVGElement, AnimatedIconProps>((props, forwarded) => {
  const { ref, controls } = useIconControls(forwarded);
  return (
    <IconSvg ref={ref} name="trash-2" animate={controls} {...props}>
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <m.g variants={lift} style={{ originX: 0, originY: 1 }}>
        <path d="M3 6h18" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </m.g>
    </IconSvg>
  );
});
Trash2.displayName = "Trash2";
```

As in Step 4, check the paths against the installed `lucide-react`'s `trash-2.js`. Children inherit the `normal`/`animate` label from the svg's `animate={controls}`, so only the parts that move get `variants`.

- [ ] **Step 6: Barrel** (`src/components/icons/index.ts`)

```ts
// Animated icons (hover/keyboard-focus of their control plays them). Names match lucide-react.
export { Settings } from "./settings";
export { Trash2 } from "./trash-2";

// Status-only icons stay static.
export { Circle, CircleIcon, Loader2, Loader2Icon, SignalHigh, SignalLow, SignalMedium, SignalZero, Square } from "lucide-react";

export type { AnimatedIcon, AnimatedIconProps } from "./icon-base";
```

Remove from the static line any name that `lucide-react` doesn't export. The typecheck will tell you which.

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `rtk vitest run src/components/icons/`
Expected: PASS. `icon-base.test.tsx` passes, and `icons.test.tsx` passes for both settings and trash-2.

If the "rests" tests fail because happy-dom doesn't run motion's frame loop, take these steps in order:
- add `await tick(700)`
- set `MotionGlobalConfig.skipAnimations = true`
- if both fail, report it and don't weaken the assertion

- [ ] **Step 8: Look at it.** Temporarily render `<Button size="icon" aria-label="t"><Trash2 /></Button>` somewhere visible, or use Task 9's preview steps. Hover it: the lid should lift and settle as in mockup B. Remove the temporary render.

- [ ] **Step 9: Checkpoint.** Ready for the user to commit.

---

### Task 4: Normalise the remaining 55 registry icons

**Files:**
- Create: `src/components/icons/<name>.tsx` for each of: activity, arrow-down, arrow-left, arrow-up, at-sign, ban, bell, check, check-check, chevron-down, chevron-left, chevron-right, chevron-up, copy, download, external-link, eye, eye-off, file-text, folder-plus, grip-vertical, hand, keyboard, layout-grid, link-2, lock, maximize, maximize-2, menu, message-circle, message-square, message-square-plus, mic, mic-off, minimize, palette, pause, phone, phone-off, play, plus, refresh-cw, search, send, sliders-horizontal, smile, smile-plus, square-pen, ticket, upload, user, user-plus, users, webhook, x
- Modify: `src/components/icons/index.ts` (one `export { Name } from "./name";` line per icon, in alphabetical order)

**Interfaces:**
- Consumes: `IconSvg`, `useIconControls`, `AnimatedIconProps` (Task 2); presets (Task 3).
- Produces: one named export per file, PascalCase lucide name (`ArrowLeft`, `Link2`, `Maximize2`, `MessageSquarePlus`, `SquarePen`, `X`).

- [ ] **Step 1: Pull all raw sources into the scratchpad** (read-only reference, outside the repo)

```bash
mkdir -p "$SCRATCH/la" && cd "$SCRATCH/la"
for n in activity arrow-down arrow-left arrow-up at-sign ban bell check check-check chevron-down chevron-left chevron-right chevron-up copy download external-link eye eye-off file-text folder-plus grip-vertical hand keyboard layout-grid link-2 lock maximize maximize-2 menu message-circle message-square message-square-plus mic mic-off minimize palette pause phone phone-off play plus refresh-cw search send sliders-horizontal smile smile-plus square-pen ticket upload user user-plus users webhook x; do
  curl -sfL "https://lucide-animated.com/r/$n.json" | python -c "import json,sys;print(json.load(sys.stdin)['files'][0]['content'])" > "$n.tsx" || echo "FAIL $n"
done
```

`$SCRATCH` is the session scratchpad directory. Expected: 55 files, no `FAIL`.

- [ ] **Step 2: Normalise each file with the Task 3 `settings.tsx` shape.** For each raw file:
  1. Keep only its motion idea. Path data comes from the installed `lucide-react` `__iconNode` for that icon.
  2. Replace the `<div>` wrapper, mouse handlers, `useImperativeHandle` and `isControlledRef` with `useIconControls(forwarded)` and `<IconSvg ref={ref} name="<kebab>" animate={controls} …>`.
  3. Fold multiple `useAnimation()` controls into the single `controls`. Each moving part gets its own `variants` with `normal`/`animate` keys.
  4. Turn `motion.*` into `m.*`.
  5. Turn imperative sequences (`await controls.start(...)` chains) into keyframe arrays inside one `animate` variant. Turn loops (`repeat: Infinity`) into a single play.
  6. Make the end state rest. If the raw `animate` ends off rest (rotate 180, translate 2, pathLength 0), either rewrite it as keyframes returning to rest, or, for a symmetric spin, add `transitionEnd: { rotate: 0 }`. `pathLength` animations must end at `pathLength: 1`.
  7. Prefer a `motions.ts` preset when the raw motion is effectively one (e.g. `bell` → `ring` with `style={{ originY: 0 }}`, `plus` → `spin(90)`, `x` → `spin(90)`, `search` → `tilt`).
  8. Keep the duration within 400–700 ms.

  Use the mockup's B tab as the reference for `bell`, `copy`, `play`, `plus`, `search`, `smile-plus`, `users`:
  - `bell`: `ring`, top origin
  - `copy`: back sheet `nudge(-2.5, -2.5)`, front `nudge(1, 1)`
  - `play`: `pop`
  - `plus`: `spin(90)`
  - `search`: `tilt`
  - `smile-plus`: face `tilt`, plus strokes `spin(90)` with `style={{ originX: 0.5, originY: 0.5 }}`
  - `users`: back person `nudge(2.5)`

- [ ] **Step 3: Add the barrel exports.** Add one line per icon, alphabetical, above the static block.

- [ ] **Step 4: Run tests**

Run: `rtk vitest run src/components/icons/ && rtk pnpm typecheck`
Expected: PASS, including the "rests" tests for all 57 icons.

- [ ] **Step 5: Checkpoint.** Ready for the user to commit.

---

### Task 5: Author icons, batch 1 (chat, sidebar, composer)

**Files:**
- Create one file per icon in the table below under `src/components/icons/`
- Modify: `src/components/icons/index.ts`

**Interfaces:** same as Task 4. Component names are the PascalCase lucide name: `Ellipsis`, `Hash`, `Pin`, `PinOff`, `Pencil`, `Reply`, `SendHorizontal`, `CirclePlus`, `MessagesSquare`, `Images`, `ImagePlus`, `Megaphone`, `BookOpen`, `ScrollText`, `Star`, `Crown`, `Shield`.

**Template.** Every authored icon follows `trash-2.tsx` from Task 3. Paths come from the installed `lucide-react` `__iconNode`. "Whole" means `variants=` on `IconSvg` itself. "Part" means wrap those elements in `<m.g variants=… style=…>`, or give a single element `m.path`/`m.circle`/`m.line` with `variants`.

| Icon | What moves | Variants (from `motions.ts`) | Origin (`style`) |
|---|---|---|---|
| ellipsis | each dot, left→right | `bounce(0)`, `bounce(0.08)`, `bounce(0.16)` | — |
| hash | whole | `shake` | — |
| pin | whole | `drop` | — |
| pin-off | whole | `shake` | — |
| pencil | whole | `scribble` | — |
| reply | whole | `variants({ x: [0, -4, 1, 0] })` | — |
| send-horizontal | whole | `fly(14)` | — |
| circle-plus | the two plus strokes as one `m.g` | `spin(90)` | `originX: 0.5, originY: 0.5` |
| messages-square | back bubble / front bubble | `nudge(-1.5, -1.5)` / `nudge(1, 1)` | — |
| images | back frame / front frame | `nudge(-1.5, -1.5)` / `nudge(1, 1)` | — |
| image-plus | the plus strokes as one `m.g` | `spin(90)` | `originX: 0.5, originY: 0.5` |
| megaphone | whole | `variants({ rotate: [0, -10, 8, -4, 0] })` | `originX: 0, originY: 0.5` |
| book-open | whole | `hop` | — |
| scroll-text | whole | `hop` | — |
| star | whole | `variants({ rotate: [0, -15, 15, 0], scale: [1, 1.2, 1.2, 1] })` | — |
| crown | whole | `hop` | — |
| shield | whole | `pop` | — |

- [ ] **Step 1: Create the files** as in the table, each with `displayName` set to its export name.
- [ ] **Step 2: Add barrel exports.** Add `MoreHorizontal` as an alias of `Ellipsis`: `export { Ellipsis, Ellipsis as MoreHorizontal } from "./ellipsis";`. In lucide, `MoreHorizontal` is the same icon.
- [ ] **Step 3: Run** `rtk vitest run src/components/icons/ && rtk pnpm typecheck`. Expected: PASS.
- [ ] **Step 4: Checkpoint.** Ready for the user to commit.

---

### Task 6: Author icons, batch 2 (media, voice, video)

**Files / Interfaces:** as in Task 5.

| Icon | What moves | Variants | Origin |
|---|---|---|---|
| music | whole | `hop` | — |
| list-music | the note parts (stem + head) | `hop` | — |
| shuffle | the two arrowheads (`m18 14 4 4-4 4`, `m18 2 4 4-4 4`) | `nudge(3)` | — |
| repeat | whole | `spin(360)` | — |
| repeat-1 | whole except the "1" | `spin(360)` | `originX: 0.5, originY: 0.5` |
| skip-forward | the triangle | `nudge(4)` | — |
| skip-back | the triangle | `nudge(-4)` | — |
| volume-1 | the wave arc | `blink(0)` | — |
| volume-2 | inner wave / outer wave | `blink(0)` / `blink(0.12)` | — |
| volume-x | the two x strokes as one `m.g` | `spin(90)` | `originX: 0.5, originY: 0.5` |
| headphones | whole | `hop` | — |
| headphone-off | whole | `shake` | — |
| video | the lens part (the triangle/`m16 13` path) | `nudge(2)` | — |
| video-off | whole | `shake` | — |
| screen-share | the arrow parts | `nudge(2, -2)` | — |
| screen-share-off | whole | `shake` | — |
| monitor | the screen rect | `variants({ scale: [1, 0.92, 1.04, 1] })` | — |
| monitor-up | the arrow parts | `nudge(0, -3)` | — |
| tv | whole | `hop` | — |
| film | whole | `variants({ x: [0, 2, -1, 0] })` | — |
| gamepad-2 | whole | `shake` | — |
| rss | inner arc / outer arc | `blink(0)` / `blink(0.12)` | — |

- [ ] **Step 1: Create the files.**
- [ ] **Step 2: Add barrel exports.**
- [ ] **Step 3: Run** `rtk vitest run src/components/icons/ && rtk pnpm typecheck`. Expected: PASS.
- [ ] **Step 4: Checkpoint.**

---

### Task 7: Author icons, batch 3 (everything else)

**Files / Interfaces:** as in Task 5.

| Icon | What moves | Variants | Origin |
|---|---|---|---|
| arrow-left-right | top arrow / bottom arrow | `nudge(-2)` / `nudge(2)` | — |
| circle-user | head + shoulders (all but the outer circle) | `nudge(0, -1.5)` | — |
| user-round | head circle | `nudge(0, -1.5)` | — |
| code | left chevron / right chevron | `nudge(-2)` / `nudge(2)` | — |
| command | whole | `spin(90)` | — |
| database | top ellipse | `nudge(0, -2)` | — |
| file | whole | `shake` | — |
| file-archive | whole | `shake` | — |
| filter-x | the x strokes as one `m.g` | `spin(90)` | `originX: 0.5, originY: 0.5` |
| globe | the meridian ellipse path | `squash("scaleX")` | — |
| list | each line, top→bottom | `bounce(0, "x")`, `bounce(0.05, "x")`, `bounce(0.1, "x")` (one per row; dots static) | — |
| list-plus | the plus strokes as one `m.g` | `spin(90)` | `originX: 0.5, originY: 0.5` |
| list-x | the x strokes as one `m.g` | `spin(90)` | `originX: 0.5, originY: 0.5` |
| log-out | the arrow parts | `nudge(3)` | — |
| minus | whole | `squash("scaleX")` | — |
| more-vertical | each dot, top→bottom | `variants({ scale: [1, 1.6, 1] }, { delay: 0 })`, `… 0.08`, `… 0.16` | — |
| panel-left | the divider line | `nudge(-2)` | — |
| plug | whole | `variants({ x: [0, -2, 1, 0] })` | — |
| search-x | whole | `tilt` | — |
| settings-2 | first knob circle / second knob circle | `nudge(3)` / `nudge(-3)` | — |
| triangle-alert | whole | `shake` | `originX: 0.5, originY: 1` |
| type | whole | `squash("scaleY")` | `originX: 0.5, originY: 1` |
| unlink-2 | left link / right link | `nudge(-2)` / `nudge(2)` | — |
| zoom-in | whole | `tilt` | — |
| zoom-out | whole | `tilt` | — |

Barrel aliases: `export { EllipsisVertical as MoreVertical }` if the file is named `ellipsis-vertical.tsx`. Otherwise export `MoreVertical` directly from `more-vertical.tsx`. Use the name the app imports.

- [ ] **Step 1: Create the files.**
- [ ] **Step 2: Add barrel exports.**
- [ ] **Step 3: Coverage check.** List what app code still imports from lucide-react with no animated or static barrel export:

```bash
cd clients/web
grep -rhoE "import \{[^}]*\} from \"lucide-react\"" src --include=*.tsx | grep -v "^src/components/ui" | tr ',{}' '\n\n\n' | sed -E 's/import|from.*|type //g;s/ as .*//;s/^\s+|\s+$//g' | grep -E "^[A-Z]" | sort -u > "$SCRATCH/used.txt"
node -e "const b=require('fs').readFileSync('src/components/icons/index.ts','utf8');for(const n of require('fs').readFileSync(process.env.SCRATCH+'/used.txt','utf8').split('\n').filter(Boolean)){if(n==='LucideIcon')continue;if(!new RegExp('\\\\b'+n+'\\\\b').test(b))console.log('MISSING',n)}"
```

Expected: no `MISSING` lines. For a missing `XxxIcon` alias, add `export { Xxx as XxxIcon } from "./xxx";`. For a missing icon that isn't in the spec inventory, author it from the template using the closest table row.

- [ ] **Step 4: Run** `rtk vitest run src/components/icons/ && rtk pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

---

### Task 8: Migrate app imports

This runs last, after the parallel sessions (twitch-mature-gate on `src/app/watch/*`, error-pages on router/error components) have merged. Before starting, re-run the coverage check from Task 7 Step 3 on the merged code.

**Files:**
- Modify: every `src/**/*.tsx` outside `src/components/ui/` and `src/components/icons/` that imports from `"lucide-react"` (~120 files)
- Test: `src/components/icons/imports.test.ts`

**Interfaces:**
- Consumes: the barrel `@/components/icons`, with `AnimatedIcon` replacing `LucideIcon`.

- [ ] **Step 1: Write the failing guard test** (`src/components/icons/imports.test.ts`)

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../..", import.meta.url));
const ALLOWED = [join(SRC, "components", "ui"), join(SRC, "components", "icons")];

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.tsx?$/.test(name)) yield p;
  }
}

describe("icon imports", () => {
  it("app code imports icons from @/components/icons, not lucide-react", () => {
    const offenders = [...files(SRC)].filter((f) => !ALLOWED.some((a) => f.startsWith(a)) && readFileSync(f, "utf8").includes('from "lucide-react"'));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `rtk vitest run src/components/icons/imports.test.ts`. Expected: FAIL, listing ~120 files.

- [ ] **Step 3: Swap imports**

```bash
cd clients/web
grep -rl 'from "lucide-react"' src --include=*.tsx --include=*.ts | grep -v -E "src/components/(ui|icons)/" | xargs sed -i -E 's#from "lucide-react"#from "@/components/icons"#; s/\btype LucideIcon\b/type AnimatedIcon/; s/\bLucideIcon\b/AnimatedIcon/g'
```

- [ ] **Step 4: Run all checks**

Run: `rtk pnpm typecheck && rtk vitest run`
Expected: PASS, including the guard. If a name is missing from the barrel, add it there; never edit the call site's identifier.

- [ ] **Step 5: Tell the sibling sessions.** Update `C:\Users\Filip\AppData\Roaming\Claude\side-session-notes\local_117f7504-cfa2-4179-93d2-dfef812eed30\animated-icons.md` to say the import swap has landed, and to use `@/components/icons` in new code.

- [ ] **Step 6: Checkpoint.**

---

### Task 9: Verify in the browser and measure

**Files:** none changed, unless verification finds a bug.

- [ ] **Step 1: Bundle size.** Run `rtk pnpm build` and compare the `index-*.js` gzip size against the Task 1 baseline. Expected: an increase of roughly 15–20 KB gzip. Above 30 KB → report to the user before calling this done.

- [ ] **Step 2: Start the preview.** Use `preview_start` with the web dev server from `.claude/launch.json`; create that entry if it's missing (`pnpm --dir clients/web dev`, port from `vite.config.ts`). Sign in with the project's seed or dev test account.

- [ ] **Step 3: Hover each surface** with `computer` hover and `zoom`, comparing against mockup B:
  - sidebar: channel settings gear, create-channel plus, user-bar bell and settings
  - top bar: search, pin, users, bell
  - message hover toolbar: smile-plus, reply, pencil, pin, copy, trash-2, ellipsis
  - composer: circle-plus, smile, send
  - music player: shuffle, skip, play, repeat, volume
  - settings nav, mobile tab bar (`resize_window` preset mobile, then back to desktop)

  Each icon should play once and settle. Check `read_console_messages` for errors: none expected, and specifically no `LazyMotion strict` error.

- [ ] **Step 4: Static icons stay static.** Hover a non-interactive heading icon and a `Loader2` spinner region. Expected: no motion beyond the spinner's own spin.

- [ ] **Step 5: Keyboard.** Tab onto a toolbar button. Expected: its icon plays once. Clicking a button with the mouse plays it only from hover, not a second time.

- [ ] **Step 6: Reduced motion.** The pane can't emulate `prefers-reduced-motion`. Verify through the Task 3 "rests" tests (which guarantee invisible snaps), and ask the user to try once with Windows "Animation effects" off.

- [ ] **Step 7: Full suites.** Run `rtk pnpm typecheck && rtk vitest run && rtk playwright test` from `clients/web`. Expected: all pass. Report e2e failures with their output; don't skip them.

- [ ] **Step 8: Screenshot** the message toolbar mid-hover as proof, send it to the user, and say everything is ready for them to commit.
