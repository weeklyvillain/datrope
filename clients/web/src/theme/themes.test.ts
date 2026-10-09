import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, THEMES, THEME_IDS, themeVars } from "./themes";

const TOKENS = [
  "--background", "--foreground", "--card", "--card-foreground", "--popover", "--popover-foreground",
  "--primary", "--primary-foreground", "--secondary", "--secondary-foreground", "--muted", "--muted-foreground",
  "--accent", "--accent-foreground", "--border", "--input", "--ring", "--sidebar", "--sidebar-foreground",
  "--online", "--mention", "--mention-foreground", "--topbar", "--topbar-foreground",
];

describe("themes", () => {
  it("has the default plus 10 themes with unique labels", () => {
    expect(THEME_IDS[0]).toBe(DEFAULT_THEME);
    expect(THEME_IDS).toHaveLength(11);
    expect(new Set(THEME_IDS.map((id) => THEMES[id].label)).size).toBe(11);
  });

  it("maps every theme onto every token", () => {
    for (const id of THEME_IDS) {
      const vars = themeVars(THEMES[id].colors);
      expect(Object.keys(vars).sort()).toEqual([...TOKENS].sort());
      for (const v of Object.values(vars)) expect(v).not.toBe("");
    }
  });

  it("picks readable mention badge text by luminance", () => {
    expect(themeVars(THEMES["material-dark-indigo"].colors)["--mention-foreground"]).toBe("#ffffff");
    expect(themeVars(THEMES["stark-contrast"].colors)["--mention-foreground"]).toBe("#131313");
  });

  it("uses the Slack colours directly where they map 1:1", () => {
    const vars = themeVars(THEMES.gotham.colors);
    expect(vars["--sidebar"]).toBe("#0a0f14");
    expect(vars["--primary"]).toBe("#265360");
    expect(vars["--topbar"]).toBe("#10151b");
    expect(vars["--background"]).toBe("color-mix(in srgb, #0a0f14 45%, #131313)");
  });
});
