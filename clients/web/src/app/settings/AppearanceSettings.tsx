import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { setTheme, useThemeId } from "@/theme/prefs";
import { THEMES, THEME_IDS, themeVars, type ThemeId } from "@/theme/themes";

/** Theme picker: a card per theme with a small preview of its sidebar, accent and hover colours. */
export function AppearanceSettings() {
  const theme = useThemeId();
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">Themes stay on this device. Dark themes from slackthemes.net.</p>
      <RadioGroup aria-label="Theme" value={theme} onValueChange={(v) => setTheme(v as ThemeId)}
        className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
        {THEME_IDS.map((id) => {
          const { label, colors: c } = THEMES[id];
          return (
            <Label key={id} htmlFor={`theme-${id}`}
              className="grid cursor-pointer gap-2 rounded-lg border p-2.5 font-normal hover:bg-accent has-[[data-state=checked]]:border-primary">
              <span aria-hidden className="flex h-14 overflow-hidden rounded-md border">
                <span className="grid w-1/3 content-start gap-1 p-1.5" style={{ background: c.column_bg }}>
                  <span className="h-1.5 rounded-sm" style={{ background: c.text_color, opacity: 0.6 }} />
                  <span className="h-1.5 rounded-sm" style={{ background: c.active_item }} />
                  <span className="h-1.5 rounded-sm" style={{ background: c.hover_item }} />
                </span>
                <span className="flex-1" style={{ background: `color-mix(in srgb, ${c.column_bg} 45%, ${themeVars(c)["--background"]})` }}>
                  <span className="block h-3" style={{ background: c.top_nav_bg }} />
                </span>
              </span>
              <span className="flex items-center gap-2">
                <RadioGroupItem id={`theme-${id}`} value={id} />
                {label}
              </span>
            </Label>
          );
        })}
      </RadioGroup>
    </div>
  );
}
