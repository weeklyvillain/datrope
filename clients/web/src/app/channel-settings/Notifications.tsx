import { channelNotify, type NotifySetting } from "@datrope/core";
import { useId } from "react";
import { Link } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { ErrorText } from "@/components/error-text";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { useSubmit } from "@/hooks/use-submit";
import { cn } from "@/lib/utils";
import { useNotifyPrefs, type NotifyLevel } from "@/notify/prefs";
import { client, useApp } from "@/session";

type Level = NotifySetting["level"];

const DEVICE: Record<NotifyLevel, string> = { all: "all messages", mentions: "mentions and direct messages", nothing: "nothing" };

/** How I hear about this channel: a level that replaces the device's own, and mute. Saved on change, for all my devices. */
export function Notifications({ channelId }: { channelId: string }) {
  const id = useId();
  const n = useApp(useShallow((s) => channelNotify(s, channelId)));
  const device = useNotifyPrefs((p) => p.level);
  const { busy, error, run } = useSubmit();
  const save = (next: { level: Level; muted: boolean }) => void run(() => client.setChannelNotify(channelId, next));
  const options: { value: Level; title: string; hint?: string }[] = [
    { value: "default", title: "Default", hint: `Follow each device's setting (this one: ${DEVICE[device]}).` },
    { value: "all", title: "All messages" },
    { value: "mentions", title: "Only mentions" },
    { value: "nothing", title: "Nothing" },
  ];
  return (
    <>
      <Card className="gap-3 p-4">
        <div className="flex items-center gap-3">
          <div className="grow">
            <Label htmlFor={`${id}-muted`} className="font-medium">Mute channel</Label>
            <p id={`${id}-muted-hint`} className="m-0 text-sm text-muted-foreground">Dims the channel and hides its unread marker. You are still notified when someone mentions you.</p>
          </div>
          <Switch id={`${id}-muted`} aria-describedby={`${id}-muted-hint`} checked={n.muted} disabled={busy}
            onCheckedChange={(muted) => save({ level: n.level, muted })} />
        </div>
      </Card>
      <Card className="gap-3 p-4">
        <h3>Notify me about</h3>
        <RadioGroup aria-label="Notify me about" value={n.level} onValueChange={(v) => save({ level: v as Level, muted: n.muted })} className="gap-2">
          {options.map((o) => (
            <Label key={o.value} htmlFor={`${id}-${o.value}`} className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-3", n.level === o.value && "border-primary bg-primary/8")}>
              <RadioGroupItem id={`${id}-${o.value}`} value={o.value} disabled={busy} className="mt-0.5" aria-labelledby={`${id}-${o.value}-title`}
                aria-describedby={o.hint ? `${id}-${o.value}-hint` : undefined} />
              <div className="grid gap-0">
                <span id={`${id}-${o.value}-title`} className="font-medium">{o.title}</span>
                {o.hint && <span id={`${id}-${o.value}-hint`} className="text-sm font-normal text-muted-foreground">{o.hint}</span>}
              </div>
            </Label>
          ))}
        </RadioGroup>
        <p className="m-0 text-sm text-muted-foreground">
          Notifications also need to be on for the device, in <Link to="/settings/notifications" className="underline">your settings</Link>.
        </p>
        <ErrorText error={error} />
      </Card>
    </>
  );
}
