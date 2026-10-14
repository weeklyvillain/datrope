/** The colour tokens the desktop app's own screens (title bar, drawer, dialogs, picker, offline page) use. */
export const THEME_TOKENS = [
  "background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "primary", "primary-foreground",
  "secondary", "secondary-foreground", "muted", "muted-foreground", "accent", "accent-foreground", "destructive",
  "destructive-foreground", "border", "input", "ring", "sidebar", "sidebar-foreground", "topbar", "topbar-foreground",
  "online", "idle", "offline",
] as const;

/** The current value of each token (`get("--background")` → "#131313"), without empty ones. */
export function readTokens(get: (name: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of THEME_TOKENS) {
    const v = get(`--${t}`).trim();
    if (v) out[t] = v;
  }
  return out;
}
