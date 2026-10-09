/** A Slack sidebar theme: the ten colours slackthemes.net shares. */
export type SlackColors = {
  column_bg: string; menu_bg: string; active_item: string; active_item_text: string; hover_item: string;
  text_color: string; active_presence: string; mention_badge: string; top_nav_bg: string; top_nav_text: string;
};

/** "datrope" is styles.css itself; the rest are dark themes from slackthemes.net (mishaor). */
export const THEMES = {
  datrope: { label: "Datrope", colors: { column_bg: "#0d0d0d", menu_bg: "#1c1c1c", active_item: "#2ecc71", active_item_text: "#131313", hover_item: "#2a2a2a", text_color: "#bdc3c7", active_presence: "#2ecc71", mention_badge: "#e74c3c", top_nav_bg: "#1c1c1c", top_nav_text: "#bdc3c7" } },
  drund: { label: "Drund", colors: { column_bg: "#181818", menu_bg: "#202020", active_item: "#99cb3f", active_item_text: "#ffffff", hover_item: "#202020", text_color: "#ffffff", active_presence: "#99cb3f", mention_badge: "#f7124e", top_nav_bg: "#202020", top_nav_text: "#ffffff" } },
  rubyconf: { label: "RubyConf", colors: { column_bg: "#100e0e", menu_bg: "#c10800", active_item: "#ffb400", active_item_text: "#ffffff", hover_item: "#242121", text_color: "#ffffff", active_presence: "#ff2b22", mention_badge: "#ff2b22", top_nav_bg: "#c10800", top_nav_text: "#ffffff" } },
  "material-dark-indigo": { label: "Material Dark Indigo", colors: { column_bg: "#212121", menu_bg: "#212121", active_item: "#3f51b5", active_item_text: "#ffffff", hover_item: "#3f51b5", text_color: "#ffffff", active_presence: "#3f51b5", mention_badge: "#3f51b5", top_nav_bg: "#212121", top_nav_text: "#ffffff" } },
  ega: { label: "EGA", colors: { column_bg: "#0000aa", menu_bg: "#00aaaa", active_item: "#ff55ff", active_item_text: "#ffffff", hover_item: "#00aaaa", text_color: "#ffffff", active_presence: "#c0c0c0", mention_badge: "#ff00ff", top_nav_bg: "#00aaaa", top_nav_text: "#ffffff" } },
  xunit: { label: "xUnit.net", colors: { column_bg: "#162c16", menu_bg: "#444a47", active_item: "#663333", active_item_text: "#ffffff", hover_item: "#995050", text_color: "#ffffff", active_presence: "#e0e066", mention_badge: "#db6668", top_nav_bg: "#444a47", top_nav_text: "#ffffff" } },
  awa: { label: "AWA", colors: { column_bg: "#222222", menu_bg: "#333333", active_item: "#444444", active_item_text: "#ffffff", hover_item: "#333333", text_color: "#ffffff", active_presence: "#38978d", mention_badge: "#fc7459", top_nav_bg: "#333333", top_nav_text: "#ffffff" } },
  "stark-contrast": { label: "Stark Contrast", colors: { column_bg: "#000000", menu_bg: "#a51c24", active_item: "#ffffff", active_item_text: "#0320ff", hover_item: "#a5a5a5", text_color: "#ffffff", active_presence: "#ffffff", mention_badge: "#ffff00", top_nav_bg: "#a51c24", top_nav_text: "#ffffff" } },
  gotham: { label: "Gotham", colors: { column_bg: "#0a0f14", menu_bg: "#10151b", active_item: "#265360", active_item_text: "#d4ebe9", hover_item: "#d26939", text_color: "#9bd1ce", active_presence: "#edb54b", mention_badge: "#c33027", top_nav_bg: "#10151b", top_nav_text: "#9bd1ce" } },
  "wild-cherry": { label: "Wild Cherry", colors: { column_bg: "#2b1f32", menu_bg: "#ffb86c", active_item: "#e15d97", active_item_text: "#ffffff", hover_item: "#4a1386", text_color: "#ffffff", active_presence: "#35ba66", mention_badge: "#0aacc5", top_nav_bg: "#ffb86c", top_nav_text: "#ffffff" } },
  "georgia-tech": { label: "Georgia Tech", colors: { column_bg: "#00254c", menu_bg: "#15467a", active_item: "#eeb211", active_item_text: "#ffffff", hover_item: "#eeb211", text_color: "#ffffff", active_presence: "#c59353", mention_badge: "#007bff", top_nav_bg: "#15467a", top_nav_text: "#ffffff" } },
} satisfies Record<string, { label: string; colors: SlackColors }>;

export type ThemeId = keyof typeof THEMES;
export const DEFAULT_THEME: ThemeId = "datrope";
export const THEME_IDS = Object.keys(THEMES) as ThemeId[];

/** Readable text on a colour: white, or near-black when the colour is light. */
function onColor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.4 ? "#131313" : "#ffffff";
}

/** The app's tokens for a Slack theme: the sidebar and accents as given, the main area a dark tint of the sidebar. */
export function themeVars(c: SlackColors): Record<string, string> {
  const bg = `color-mix(in srgb, ${c.column_bg} 45%, #131313)`;
  const surface = `color-mix(in srgb, ${bg} 94%, white)`;
  const line = `color-mix(in srgb, ${c.text_color} 18%, ${bg})`;
  const hover = `color-mix(in srgb, ${c.hover_item} 30%, ${bg})`;
  return {
    "--background": bg,
    "--foreground": c.text_color,
    "--card": surface,
    "--card-foreground": c.text_color,
    "--popover": surface,
    "--popover-foreground": c.text_color,
    "--primary": c.active_item,
    "--primary-foreground": c.active_item_text,
    "--secondary": line,
    "--secondary-foreground": c.text_color,
    "--muted": hover,
    "--muted-foreground": `color-mix(in srgb, ${c.text_color} 62%, ${bg})`,
    "--accent": hover,
    "--accent-foreground": c.text_color,
    "--border": line,
    "--input": line,
    "--ring": c.active_item,
    "--sidebar": c.column_bg,
    "--sidebar-foreground": c.text_color,
    "--online": c.active_presence,
    "--mention": c.mention_badge,
    "--mention-foreground": onColor(c.mention_badge),
    "--topbar": c.top_nav_bg,
    "--topbar-foreground": c.top_nav_text,
  };
}
