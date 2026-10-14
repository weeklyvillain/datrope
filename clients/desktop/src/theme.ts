/** Same list as the shell's and the web client's; the shell validates, this is a second check for the fragment. */
const TOKENS = new Set([
  "background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "primary", "primary-foreground",
  "secondary", "secondary-foreground", "muted", "muted-foreground", "accent", "accent-foreground", "destructive",
  "destructive-foreground", "border", "input", "ring", "sidebar", "sidebar-foreground", "topbar", "topbar-foreground",
  "online", "idle", "offline",
]);

/** The allowlisted tokens whose values are colours (`supports` is `CSS.supports("color", v)` in the page). */
export function safeTheme(raw: unknown, supports: (value: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (TOKENS.has(k) && typeof v === "string" && supports(v)) out[k] = v;
  }
  return out;
}

/** The theme in a `#theme=<urlencoded JSON>` fragment; empty when missing or malformed. */
export function parseThemeFragment(hash: string, supports: (value: string) => boolean): Record<string, string> {
  const m = /^#theme=(.*)$/.exec(hash);
  if (!m) return {};
  try {
    return safeTheme(JSON.parse(decodeURIComponent(m[1])), supports);
  } catch {
    return {};
  }
}

let applied: string[] = [];
/** Puts a server's colour tokens on this bundled page (an empty object restores the bundled defaults). */
export function applyTheme(tokens: Record<string, string>) {
  const style = document.documentElement.style;
  for (const k of applied) if (!(k in tokens)) style.removeProperty(`--${k}`);
  for (const [k, v] of Object.entries(tokens)) style.setProperty(`--${k}`, v);
  applied = Object.keys(tokens);
}
