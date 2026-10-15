/** execCommand copy through a hidden textarea: works where the Clipboard API is missing (http, old WebViews). */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.append(el);
  el.focus({ preventScroll: true });
  el.select();
  el.setSelectionRange(0, text.length); // iOS ignores select() on its own
  try {
    // execCommand is deprecated but still the only copy path in some WebViews; kept as the fallback.
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    el.remove();
  }
}

/** Copies `text`; whether it worked. */
export async function copyText(
  text: string,
  env: { clipboard?: { writeText(t: string): Promise<void> }; fallback?: (t: string) => boolean } = {
    clipboard: typeof navigator === "undefined" ? undefined : navigator.clipboard,
    fallback: legacyCopy,
  },
): Promise<boolean> {
  if (env.clipboard) {
    try {
      await env.clipboard.writeText(text);
      return true;
    } catch {
      // permission denied or not focused: try the old way
    }
  }
  return env.fallback?.(text) ?? false;
}
