import { Hash } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { ColorPicker } from "@/components/color-picker";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { deriveTheme, readableAccent } from "@/lib/color";
import { PALETTES } from "@/lib/palettes";
import { cn } from "@/lib/utils";
import { useApp } from "@/session";
import { customPref, MAX_CUSTOM_THEMES, newThemeId, saveCustomTheme, type CustomTheme } from "@/theme/custom";
import { setTheme } from "@/theme/prefs";

const STEPS = ["Pick a colour", "Review palette", "Name it"] as const;
/** The swatches of step 2: label, token, and the token its text is drawn in. */
const LADDER = [
  ["Sidebar", "--sidebar", "--foreground"], ["Background", "--background", "--foreground"], ["Card", "--card", "--foreground"],
  ["Hover", "--muted", "--foreground"], ["Border", "--border", "--foreground"], ["Text", "--foreground", "--background"],
  ["Muted text", "--muted-foreground", "--background"], ["Accent", "--primary", "--primary-foreground"],
  ["Mention", "--mention", "--mention-foreground"], ["Online", "--online", "--background"],
] as const;

/** Create or edit a custom theme in three steps (spec: custom colors §5). */
export function ThemeBuilder({ theme, count, onClose }: { theme?: CustomTheme; count: number; onClose: () => void }) {
  const serverAccent = useApp((s) => s.server?.server.accent_color ?? PALETTES.emerald.hex);
  const [step, setStep] = useState(0);
  const [seed, setSeed] = useState(theme?.seed ?? PALETTES.ocean.hex);
  const [ownAccent, setOwnAccent] = useState(theme?.ownAccent ?? false);
  const [name, setName] = useState(theme?.name ?? `Custom ${count + 1}`);
  const vars = deriveTheme(seed, { ownAccent });
  if (!ownAccent) {
    const a = readableAccent(serverAccent, [vars["--background"]!, vars["--sidebar"]!, vars["--card"]!]);
    Object.assign(vars, { "--primary": a.primary, "--primary-foreground": a.primaryForeground, "--ring": a.primary });
  }
  const trimmed = name.trim();

  const [error, setError] = useState<string>();

  /** A new theme is selected once saved; an edited one keeps whichever theme is active. */
  const save = () => {
    const id = theme?.id ?? newThemeId();
    if (!saveCustomTheme({ id, name: trimmed.slice(0, 32), seed, ownAccent }))
      return setError(`You have ${MAX_CUSTOM_THEMES} custom themes. Delete one to make another.`);
    if (!theme) setTheme(customPref(id));
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{theme ? "Edit theme" : "Create theme"}</DialogTitle>
          <DialogDescription>{`Step ${step + 1} of 3: ${STEPS[step]}`}</DialogDescription>
        </DialogHeader>
        <ol className="flex gap-1.5" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === step ? "step" : undefined} className={cn("h-1 flex-1 rounded-full bg-muted", i <= step && "bg-primary")}>
              <span className="sr-only">{s}</span>
            </li>
          ))}
        </ol>

        {/* Kept mounted (hidden) so going Back keeps the hue of a grey pick. */}
        <div hidden={step !== 0}><ColorPicker value={seed} onChange={setSeed} /></div>

        {step === 1 && (
          <div className="grid gap-3">
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-1.5" aria-label="Palette">
              {LADDER.map(([label, token, text]) => (
                <li key={token} className="grid min-h-14 content-between rounded-md border p-2"
                  style={{ background: vars[token], color: vars[text] }}>
                  <span className="text-xs font-semibold">{label}</span>
                  <span className="font-mono text-caption">{vars[token]}</span>
                </li>
              ))}
            </ul>
            <ThemePreview vars={vars} />
            <div className="flex items-center gap-2">
              <Switch id="own-accent" checked={ownAccent} onCheckedChange={setOwnAccent} />
              <Label htmlFor="own-accent">Use my colour for accents</Label>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="grid gap-1.5">
            <Label htmlFor="theme-name">Theme name</Label>
            <Input id="theme-name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
            <ErrorText error={error} />
          </div>
        )}

        <DialogFooter>
          {step > 0 && <Button variant="outline" onClick={() => setStep(step - 1)}>Back</Button>}
          {step < 2 ? <Button onClick={() => setStep(step + 1)}>Next</Button>
            : <Button disabled={!trimmed} onClick={save}>Save theme</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The app in miniature, wearing `vars` through the token utilities. */
function ThemePreview({ vars }: { vars: Record<string, string> }) {
  return (
    <div aria-label="Preview of the theme" style={vars as CSSProperties}
      className="grid min-h-36 grid-cols-[120px_minmax(0,1fr)] overflow-hidden rounded-lg border text-sm">
      <div className="grid content-start gap-1 bg-sidebar p-2 text-sidebar-foreground">
        <span className="flex items-center gap-1.5 rounded-md bg-accent px-2 py-1"><Hash className="size-3.5" aria-hidden />general</span>
        <span className="flex items-center gap-1.5 px-2 py-1 text-muted-foreground"><Hash className="size-3.5" aria-hidden />games
          <span className="ml-auto rounded-full bg-mention px-1.5 text-xs font-bold text-mention-foreground">3</span></span>
        <span className="flex items-center gap-1.5 px-2 py-1"><span className="size-2 rounded-full bg-online" aria-hidden />filip</span>
      </div>
      <div className="grid content-start gap-2 bg-background p-3 text-foreground">
        <p><span className="rounded bg-primary/20 px-1 font-semibold">@you</span> looks great. <span className="text-primary">See the docs</span></p>
        <p className="text-muted-foreground">12:05 · agreed</p>
        <div className="flex gap-2">
          <Button size="sm" tabIndex={-1}>Send</Button>
          <Button size="sm" variant="outline" tabIndex={-1}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
