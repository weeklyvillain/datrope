type Containing = { contains(n: unknown): boolean };

/** After a menu or dialog closes: true when focus already moved somewhere outside its trigger (leave it there),
 *  false when nothing has focus or it is still inside the trigger (return focus to the trigger). */
export function shouldKeepFocus(active: unknown, trigger: Containing | null, body: unknown): boolean {
  if (!active || active === body) return false;
  return !(trigger?.contains(active) ?? false);
}

const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable=false])";

/** onCloseAutoFocus for a context menu on a row: return focus to the row's link or button unless focus
 *  already went elsewhere (a dialog, a field). */
export function restoreFocus(e: Event, trigger: HTMLElement | null, selector = "a,button") {
  e.preventDefault();
  const a = document.activeElement;
  if (a?.matches(EDITABLE) || shouldKeepFocus(a, trigger, document.body)) return;
  trigger?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
}
