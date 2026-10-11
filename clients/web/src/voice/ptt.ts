const NOT_TYPING = new Set(["checkbox", "radio", "range", "button", "submit", "reset", "color", "file"]);

/** Whether a key press is typing (into a text box or editable element) rather than a shortcut. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; type?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return el.tagName === "INPUT" && !NOT_TYPING.has(el.type ?? "");
}

/**
 * Reports when the push-to-talk key goes down and up. Typing it into a text field doesn't count; leaving the
 * window (or hiding the tab) lets go, so the mic can't stay open. Returns a function that stops listening.
 */
export function watchPtt(target: EventTarget, getCode: () => string, onChange: (down: boolean) => void): () => void {
  let down = false;
  const set = (d: boolean) => {
    if (d === down) return;
    down = d;
    onChange(d);
  };
  const keydown = (e: Event) => {
    const k = e as KeyboardEvent;
    if (k.code === getCode() && !k.repeat && !isTyping(k.target)) set(true);
  };
  const keyup = (e: Event) => {
    if ((e as KeyboardEvent).code === getCode()) set(false);
  };
  const release = () => set(false);
  const hidden = () => {
    if (document.hidden) set(false);
  };
  const doc = typeof document === "undefined" ? undefined : document;
  target.addEventListener("keydown", keydown);
  target.addEventListener("keyup", keyup);
  target.addEventListener("blur", release);
  doc?.addEventListener("visibilitychange", hidden);
  return () => {
    target.removeEventListener("keydown", keydown);
    target.removeEventListener("keyup", keyup);
    target.removeEventListener("blur", release);
    doc?.removeEventListener("visibilitychange", hidden);
  };
}

/** Push to talk from two places (keys in the window, the desktop app's global shortcut): down while either is. */
export function combinePtt(onChange: (down: boolean) => void) {
  const held = { local: false, global: false };
  let down = false;
  return {
    set(source: "local" | "global", d: boolean) {
      held[source] = d;
      const next = held.local || held.global;
      if (next === down) return;
      down = next;
      onChange(next);
    },
  };
}
