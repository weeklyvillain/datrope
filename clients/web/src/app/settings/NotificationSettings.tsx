import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { desktop } from "../../desktop";
import { needsHomeScreen } from "../../notify/push";
import { setNotifyEnabled, setNotifyLevel, useNotifyPrefs, type NotifyLevel } from "../../notify/prefs";

const currentPermission = (): NotificationPermission | "unsupported" =>
  desktop ? "granted" : "Notification" in window ? Notification.permission : "unsupported";

const options: { value: NotifyLevel; title: string; hint?: string }[] = [
  { value: "all", title: "All messages", hint: "Every message in channels you can read, plus DMs." },
  { value: "mentions", title: "Mentions and direct messages", hint: "Recommended." },
  { value: "nothing", title: "Nothing" },
];

export function NotificationSettings() {
  const enabled = useNotifyPrefs((p) => p.enabled);
  const level = useNotifyPrefs((p) => p.level);
  const [permission, setPermission] = useState(currentPermission);

  // Allowing notifications in the browser's site settings happens outside the page; re-read on return.
  useEffect(() => {
    const refresh = () => setPermission(currentPermission());
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  async function toggle(on: boolean) {
    if (!on) return setNotifyEnabled(false);
    let p = currentPermission();
    if (p === "default") {
      try {
        p = (await Notification.requestPermission()) ?? currentPermission();
      } catch {
        p = currentPermission();
      }
    }
    setPermission(p);
    setNotifyEnabled(p === "granted");
  }

  return (
    <Card role="region" aria-label="Notifications" className="gap-3 p-4">
      <h3>Notifications</h3>
      <div className="flex items-center gap-3">
        <div className="grow">
          <Label htmlFor="notify-enabled" className="font-medium">Desktop notifications</Label>
          <p className="m-0 text-sm text-muted-foreground">Show a system notification when Datrope is in the background or you are in another conversation.</p>
          {permission === "unsupported" && (
            <p id="notify-unsupported" className="m-0 text-sm text-muted-foreground">
              {needsHomeScreen()
                ? "Add Datrope to your Home Screen to get notifications when the app is closed."
                : "This browser cannot show notifications."}
            </p>
          )}
        </div>
        <Switch id="notify-enabled" disabled={permission === "unsupported"} aria-describedby={permission === "unsupported" ? "notify-unsupported" : undefined}
          checked={enabled && permission === "granted"} onCheckedChange={(on) => void toggle(on)} />
      </div>
      <p className="m-0 mt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notify me about</p>
      <RadioGroup aria-label="Notify me about" value={level} onValueChange={(v) => setNotifyLevel(v as NotifyLevel)} className="gap-2">
        {options.map((o) => (
          <Label key={o.value} htmlFor={`notify-${o.value}`} className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-3", level === o.value && "border-primary bg-primary/8")}>
            <RadioGroupItem id={`notify-${o.value}`} value={o.value} className="mt-0.5" aria-labelledby={`notify-${o.value}-title`} aria-describedby={o.hint ? `notify-${o.value}-hint` : undefined} />
            <div className="grid gap-0">
              <span id={`notify-${o.value}-title`} className="font-medium">{o.title}</span>
              {o.hint && <span id={`notify-${o.value}-hint`} className="text-sm font-normal text-muted-foreground">{o.hint}</span>}
            </div>
          </Label>
        ))}
      </RadioGroup>
      {permission === "denied" && (
        <div role="status" className="rounded-lg border border-idle px-3 py-2.5 text-sm text-idle">
          Your browser is blocking notifications for this site. Allow them in the address bar site settings, then turn this on again.
        </div>
      )}
    </Card>
  );
}
