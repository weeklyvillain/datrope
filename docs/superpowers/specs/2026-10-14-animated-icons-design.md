# Animated icons — design

Date: 2026-10-14 · Status: approved in chat, spec pending review · Mockup: `docs/superpowers/mockups/AnimatedIcons.html` (concept **B · Spring**)

## Goal

Every icon-only and icon+label control in the web client (`clients/web`) plays a short, playful, icon-specific animation when the user hovers or keyboard-focuses it. Pure polish ("hover delight"): no state feedback, no always-on motion.

Decided with the user:

| Question | Answer |
|---|---|
| Purpose | Hover delight |
| Where | Icon buttons app-wide |
| Implementation | lucide-animated registry + `motion` |
| Icons missing from the registry | Author them in the same style |
| Motion personality | B · Spring: one-shot, per-icon story, ~600 ms, slight overshoot |

## Non-goals

- Action feedback (Copy→Check morphs, Play↔Pause morphs) and live status motion (speaking, equalizer, typing).
- Animating icons that are not inside an interactive element.
- Changing any accessible name, label, layout, size, or color.
- Touching generated shadcn components in `src/components/ui/*`.

## Inventory (as of 2026-10-14)

App code (outside `src/components/ui/`) imports 129 distinct lucide icons from `lucide-react`.

- **Stay static on `lucide-react`** (status-only, no meaningful hover): `Loader2`, `Circle`, `Square`, `SignalHigh`, `SignalLow`, `SignalMedium`, `SignalZero`. All of `src/components/ui/*` also stays on `lucide-react`.
- **From the registry (56):** activity, arrow-down, arrow-left, arrow-up, at-sign, ban, bell, check, check-check, chevron-down, chevron-left, chevron-right, chevron-up, copy, download, external-link, eye, eye-off, file-text, folder-plus, grip-vertical, hand, keyboard, layout-grid, link-2, lock, maximize, maximize-2, menu, message-circle, message-square, message-square-plus, mic, mic-off, minimize, palette, pause, phone, phone-off, play, plus, refresh-cw, search, send, settings, sliders-horizontal, smile, smile-plus, square-pen, ticket, upload, user, user-plus, users, webhook, x.
- **Authored by us (66):** arrow-left-right, book-open, circle-plus, circle-user, code, command, crown, database, ellipsis, file, file-archive, film, filter-x, gamepad-2, globe, hash, headphone-off, headphones, image-plus, images, list, list-music, list-plus, list-x, log-out, megaphone, messages-square, minus, monitor, monitor-up, more-horizontal, more-vertical, music, panel-left, pencil, pin, pin-off, plug, repeat, repeat-1, reply, rss, screen-share, screen-share-off, scroll-text, search-x, send-horizontal, settings-2, shield, shuffle, skip-back, skip-forward, star, trash-2, triangle-alert, tv, type, unlink-2, user-round, video, video-off, volume-1, volume-2, volume-x, zoom-in, zoom-out.

The implementation re-derives this list from the code at the time and adjusts it. Any icon added later without an animated version simply stays on `lucide-react`.

## Architecture

### Dependency

`motion` (v12, React 18 compatible). Icons render `m.svg` / `m.path` etc. (not `motion.*`) so the root can load only the `domAnimation` feature set via `LazyMotion`. Measure the gzip size of the main bundle before and after; the expected cost is roughly 15–20 KB gzip. If it lands well above that, report it before continuing.

### Root providers (`src/main.tsx`)

Wrap the tree in:

```tsx
<LazyMotion features={domAnimation} strict>
  <MotionConfig reducedMotion="user">…</MotionConfig>
</LazyMotion>
```

`strict` makes any stray `motion.*` import throw in development, which keeps the bundle lean. `reducedMotion="user"` turns off transform/layout animation for every icon when the OS asks for reduced motion. Because that alone still lets opacity and stroke redraws play, `useIconControls` also skips binding the hover listeners when `useReducedMotionConfig()` is true.

### Icon files (`src/components/icons/<kebab-name>.tsx`)

One file per icon. Registry icons are fetched (`pnpm dlx shadcn@latest add https://lucide-animated.com/r/<name>.json`, or the JSON fallback from AGENTS.md) and then normalised. Authored icons use the same shape from the start. Normalised shape:

- `forwardRef<SVGSVGElement, AnimatedIconProps>`; renders a single `m.svg`, with **no wrapper element**. The registry's `<div>` and its own mouse handlers are removed, along with the `startAnimation`/`stopAnimation` imperative handle.
- Props mirror the lucide subset the app uses: `size` (default 24), `strokeWidth` (default 2), `className`, plus any other SVG props (`aria-*`, `style`, `onClick`…). `className` is merged with `cn("lucide lucide-<name>", className)` so sizing utilities like `[&_svg]:size-4`, `size-5` and color classes behave exactly as with lucide.
- `aria-hidden="true"` by default, as lucide does. A caller-supplied `aria-label` still wins.
- Animation: one `controls` per icon, set on the svg. Parts animate through child `variants`, which inherit the `normal` / `animate` label. Registry icons with several controls are folded into this. `useIconControls(ref)` supplies the svg ref and the controls, wired to `start("animate")` / `start("normal")`. Variants named `normal` / `animate`.
- Spring personality: one-shot motions that play out and settle (keyframe arrays or springs with slight overshoot), ~400–700 ms. Registry animations are kept as-is unless one clashes with this (for example a loop that never settles); those are adjusted to one-shot. Authored animations follow the mockup where it covers the icon (trash lid lifts, ellipsis dots wave, volume waves pulse, pin drops, pencil scribbles, reply swings back, send-horizontal flies out and returns, skip slides, shuffle arrows nudge, repeat spins 360°, hash shakes, music note hops). For the rest, pick a motion that matches the icon's meaning. Simple transforms (rotate, translate, scale on the whole svg or a part) are preferred over path morphing.

### Hover wiring (`src/components/icons/icon-base.tsx`)

```ts
bindIconHover(icon: Element, start: () => void, stop: () => void): () => void   // pure DOM, returns cleanup
useIconControls(forwardedRef): { ref: (el: SVGSVGElement | null) => void; controls: AnimationControls }
```

`useIconControls` wraps `useAnimation()` and calls `bindIconHover` in an effect. Every icon file uses it, so the spec's "useIconHover" is this pair. Every `animate` variant ends at rest (identity transform, opacity 1), or resets to rest with `transitionEnd` for symmetric spins. Reduced motion then snaps invisibly, and leaving never plays a spin backwards.

- On mount, finds `icon.closest('button, a[href], [role="button"], [role="menuitem"], [role="tab"], [role="option"], summary')`. If there is no such ancestor, it does nothing, so the icon stays static.
- Attaches `pointerenter`/`pointerleave` listeners to that ancestor. They only act when `e.pointerType === "mouse"` or `"pen"`, so touch taps don't fire them.
- Attaches `focusin`/`focusout`. Start only when the ancestor matches `:focus-visible`, so keyboard focus animates and mouse clicks don't trigger a second play.
- Removes all listeners on unmount or when the ancestor changes.
- Calls are idempotent: a second `start` while one is playing simply restarts it.

### Barrel (`src/components/icons/index.ts`)

Re-exports each icon under the **exact lucide names the app imports today**, including the `…Icon` aliases (`CheckIcon`, `XIcon`, `CircleIcon` where applicable, `ChevronDownIcon`…). It also exports:

```ts
export type AnimatedIcon = ComponentType<AnimatedIconProps>; // replaces LucideIcon
```

Static icons are re-exported from `lucide-react` through the same barrel. Call sites then have one import source, and `AnimatedIcon` accepts both kinds, since lucide components satisfy `AnimatedIconProps`.

### Migration

In app code, change `from "lucide-react"` to `from "@/components/icons"` and `LucideIcon` to `AnimatedIcon`. Identifiers stay the same, so each file's diff is the import line (plus the type rename in 7 files). `src/components/ui/*` and `src/lib/brand-icons.tsx` are not touched.

Parallel sessions are editing `src/app/watch/*` and router/error components. The import swap runs as the last step, after rebasing on their merged work, so the diffs don't conflict. Their sessions are told before it lands.

## Error handling

There is no runtime error surface. Missing `closest()` ancestor = static icon. With reduced motion on, `MotionConfig` skips transforms. If `motion` fails to load, it is a build-time failure, not a runtime one.

## Testing

- **Vitest** `icon-base.test.tsx`:
  - starts on mouse `pointerenter` of the parent button, stops on `pointerleave`
  - ignores `pointerType: "touch"`
  - starts on `focusin` when the parent is `:focus-visible`
  - no-op without an interactive ancestor
  - listeners removed on unmount
- **Vitest** barrel smoke test: every export renders an `<svg>` with `aria-hidden`, the `lucide-<name>` class, and the passed `className`.
- **Existing suites:** `vitest`, `tsc`, lint and Playwright e2e pass unchanged. Accessible names are untouched.
- **Browser preview:**
  - hover each surface from the mockup (sidebar, top bar, message toolbar, composer, music player, settings nav, mobile tab bar) and confirm each icon animates and settles
  - check that a status icon (`Loader2`, signal bars) doesn't react
  - emulate `prefers-reduced-motion: reduce` and confirm no transform motion
  - compare bundle size before and after

## Done when

All 122 animatable icons animate in the Spring style on hover and keyboard focus of their control, and stay static elsewhere and under reduced motion. Tests and typecheck pass, and this is verified in the browser preview. Nothing is committed; the user commits.
