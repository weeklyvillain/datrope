import { m, useAnimation, useReducedMotionConfig, type Variants } from "motion/react";
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
  "onAnimationStart" | "onAnimationEnd" | "onAnimationIteration" | "onDrag" | "onDragStart" | "onDragEnd" | "values"
> & { size?: number | string; strokeWidth?: number | string };

/** Replaces lucide's `LucideIcon`; lucide components satisfy it too. */
export type AnimatedIcon = ComponentType<AnimatedIconProps>;

/** motion v12 names this LegacyAnimationControls; derive it so the import can't drift. */
export type IconControls = ReturnType<typeof useAnimation>;

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
  // MotionConfig's reduced motion only skips transforms; opacity and stroke redraws would still play.
  const reduced = useReducedMotionConfig();
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
    if (!el || reduced) return;
    return bindIconHover(
      el,
      () => void controls.start("animate"),
      () => void controls.start("normal"),
    );
  }, [el, controls, reduced]);
  return { ref, controls };
}

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
