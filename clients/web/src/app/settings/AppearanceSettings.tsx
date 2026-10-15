import { MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { setClockPref, useClockPref, type ClockPref } from "@/lib/clock-pref";
import { cn } from "@/lib/utils";
import { useApp } from "@/session";
import { activeVars, customPref, MAX_CUSTOM_THEMES, removeCustomTheme, resolveTheme, useCustomThemes, type CustomTheme } from "@/theme/custom";
import { setTheme, useThemeId, type ThemePref } from "@/theme/prefs";
import { THEMES, THEME_IDS, themeVars } from "@/theme/themes";
import { ThemeBuilder } from "./ThemeBuilder";

const CARD = "grid cursor-pointer gap-2 rounded-lg border p-2.5 font-normal hover:bg-accent has-[[data-state=checked]]:border-primary";

/** Theme picker: a card per built-in theme and per custom theme, plus "Create theme". */
export function AppearanceSettings() {
  const theme = useThemeId();
  const customs = useCustomThemes();
  const serverAccent = useApp((s) => s.server?.server.accent_color);
  const [editing, setEditing] = useState<CustomTheme | "new">();
  const [deleting, setDeleting] = useState<CustomTheme>();
  const full = customs.length >= MAX_CUSTOM_THEMES;

  const clock = useClockPref();
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">Themes stay on this device. Dark themes from slackthemes.net, or make your own from one colour.</p>
      <RadioGroup aria-label="Theme" value={theme} onValueChange={(v) => setTheme(v as ThemePref)}
        className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
        {THEME_IDS.map((id) => {
          const { label, colors: c } = THEMES[id];
          return (
            <Label key={id} htmlFor={`theme-${id}`} className={CARD}>
              <Thumb sidebar={c.column_bg} main={`color-mix(in srgb, ${c.column_bg} 45%, ${themeVars(c)["--background"]})`} bar={c.top_nav_bg} items={[c.text_color, c.active_item, c.hover_item]} />
              <span className="flex items-center gap-2"><RadioGroupItem id={`theme-${id}`} value={id} />{label}</span>
            </Label>
          );
        })}
        {customs.map((t) => {
          const v = activeVars(resolveTheme(customPref(t.id), customs), serverAccent, true);
          return (
            <div key={t.id} className="relative">
              <Label htmlFor={`theme-${t.id}`} className={cn(CARD, "h-full")}>
                <Thumb sidebar={v["--sidebar"]!} main={v["--background"]!} bar={v["--card"]!} items={[v["--foreground"]!, v["--primary"]!, v["--muted"]!]} />
                <span className="flex items-center gap-2 pr-7">
                  <RadioGroupItem id={`theme-${t.id}`} value={customPref(t.id)} />
                  <span className="min-w-0 truncate">{t.name}</span>
                </span>
              </Label>
              <DropdownMenu>
                <DropdownMenuTrigger aria-label={`Options for ${t.name}`}
                  className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "absolute right-2 bottom-2 size-7")}>
                  <MoreHorizontal aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setEditing(t)}>Edit</DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(t)}>Delete</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </RadioGroup>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={full} onClick={() => setEditing("new")}><Plus aria-hidden />Create theme</Button>
        {full && <span className="text-sm text-muted-foreground">You have {MAX_CUSTOM_THEMES} custom themes. Delete one to make another.</span>}
      </div>

      {editing && <ThemeBuilder theme={editing === "new" ? undefined : editing} count={customs.length} onClose={() => setEditing(undefined)} />}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>The theme is removed from this device.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleting && removeCustomTheme(deleting.id)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="grid gap-2 pt-4">
        <p className="text-sm font-medium">Clock</p>
        <p className="text-sm text-muted-foreground">How times show in messages, including times people write ("9pm") converted to your time zone. Your time zone is sent with your messages so others see your times in theirs.</p>
        <RadioGroup aria-label="Clock" value={clock} onValueChange={(v) => setClockPref(v as ClockPref)} className="flex gap-4">
          {([["auto", "Automatic"], ["12", "12-hour"], ["24", "24-hour"]] as const).map(([v, label]) => (
            <Label key={v} htmlFor={`clock-${v}`} className="flex items-center gap-2 font-normal">
              <RadioGroupItem id={`clock-${v}`} value={v} /> {label}
            </Label>
          ))}
        </RadioGroup>
      </div>
    </div>
  );
}

/** A theme in miniature: sidebar with three items, the main area with its top bar. */
function Thumb({ sidebar, main, bar, items }: { sidebar: string; main: string; bar: string; items: [string, string, string] }) {
  return (
    <span aria-hidden className="flex h-14 overflow-hidden rounded-md border">
      <span className="grid w-1/3 content-start gap-1 p-1.5" style={{ background: sidebar }}>
        <span className="h-1.5 rounded-sm" style={{ background: items[0], opacity: 0.6 }} />
        <span className="h-1.5 rounded-sm" style={{ background: items[1] }} />
        <span className="h-1.5 rounded-sm" style={{ background: items[2] }} />
      </span>
      <span className="flex-1" style={{ background: main }}><span className="block h-3" style={{ background: bar }} /></span>
    </span>
  );
}
