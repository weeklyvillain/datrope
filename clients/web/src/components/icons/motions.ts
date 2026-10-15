import type { TargetAndTransition, Transition, Variants } from "motion/react";

/** The app's --ease-out-quint. */
export const EASE = [0.22, 1, 0.36, 1] as const;

const STILL = { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, opacity: 1 };
const REST = { ...STILL, rotate: 0 };

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
/**
 * Only for shapes symmetric under `deg`; snaps to 0 at the end. `normal` leaves rotate alone so
 * leaving mid-spin lets the spin finish instead of unwinding it backwards.
 */
export const spin = (deg: number): Variants => ({
  normal: { ...STILL, transition: { duration: 0.2, ease: EASE } },
  animate: { rotate: [0, deg * 1.1, deg], transitionEnd: { rotate: 0 }, transition: { duration: 0.6, ease: EASE } },
});
export const blink = (delay = 0) => variants({ opacity: [1, 0, 1] }, { delay, duration: 0.5 });
export const bounce = (delay = 0, axis: "x" | "y" = "y") => variants({ [axis]: [0, -4, 0] }, { delay, duration: 0.45 });
export const fly = (x: number) => variants({ x: [0, x, -x, 0], opacity: [1, 0, 0, 1] }, { times: [0, 0.45, 0.46, 1] });
export const squash = (axis: "scaleX" | "scaleY") => variants({ [axis]: [1, 0.7, 1.1, 1] });
/** Small pulse for dots in a grid or row. */
export const blip = (delay = 0) => variants({ scale: [1, 0.6, 1], opacity: [1, 0.4, 1] }, { delay, duration: 0.5 });
/** The stroke redraws from nothing (lucide-animated's signature move). */
export const draw = (delay = 0): Variants => ({
  normal: { pathLength: 1, opacity: 1, transition: { duration: 0.2, ease: EASE } },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: { duration: 0.4, ease: EASE, delay, opacity: { duration: 0.1, delay } },
  },
});
