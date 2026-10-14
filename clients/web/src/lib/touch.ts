/** Rows people tap on a phone: at least 44px tall on touch screens. */
export const TOUCH_ROW = "pointer-coarse:min-h-[44px]";

/** A phone or tablet with no mouse or trackpad attached: its Return key should add a line. */
export function isTouchOnly(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;
}

/** Any touch screen (even beside a mouse): long-press can happen, so touch-only sheets may be needed. */
export function canLongPress(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return matchMedia("(pointer: coarse)").matches || matchMedia("(any-pointer: coarse)").matches;
}

/** True from the first time `open` is true onwards: mount a sheet lazily, then keep it so its close animation plays. */
export function latch(was: boolean, open: boolean): boolean {
  return was || open;
}

/** Where a touch press on a message row must not preventDefault: form fields and buttons need focus, caret and clicks. */
export const KEEP_TOUCH_DEFAULT = "a, img, video, audio, input, textarea, select, [contenteditable], button";

type EnterKey = { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean };

/** What Enter does in a message box: send, add a line, or nothing special. */
export function enterAction(e: EnterKey, touchOnly: boolean): "send" | "newline" | null {
  if (e.key !== "Enter" || e.isComposing) return null;
  if (e.ctrlKey || e.metaKey) return "send";
  if (touchOnly) return "newline";
  return e.shiftKey ? "newline" : "send";
}
