import { Gamepad2, Type } from "lucide-react";
import { useId } from "react";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { withMode, type StreamMode, type StreamSettings } from "../../voice/stream-prefs";

const MODES: { value: StreamMode; label: string; hint: string; icon: typeof Gamepad2 }[] = [
  { value: "game", label: "Game", hint: "Smooth motion, 60 fps", icon: Gamepad2 },
  { value: "detail", label: "Detail", hint: "Sharp text, for code and documents", icon: Type },
];

/** Mode, resolution, frame rate and audio for a screen share; used before going live and while live. */
export function StreamFields({ value, onChange }: { value: StreamSettings; onChange: (s: StreamSettings) => void }) {
  const id = useId();
  return (
    <div className="grid gap-4">
      <RadioGroup aria-label="Mode" value={value.mode} onValueChange={(m) => onChange(withMode(value, m as StreamMode))}
        className="grid grid-cols-2 gap-2">
        {MODES.map((m) => (
          <Label key={m.value} htmlFor={`${id}-${m.value}`} className={cn(
            "grid cursor-pointer gap-1 rounded-lg border p-3 font-normal",
            value.mode === m.value && "border-primary bg-accent",
          )}>
            <span className="flex items-center gap-2 font-medium">
              <RadioGroupItem value={m.value} id={`${id}-${m.value}`} />
              <m.icon className="size-4" /> {m.label}
            </span>
            <span className="text-xs text-muted-foreground">{m.hint}</span>
          </Label>
        ))}
      </RadioGroup>
      <div className="grid gap-1.5">
        <span id={`${id}-res`} className="text-sm text-muted-foreground">Resolution</span>
        <ToggleGroup type="single" variant="outline" aria-labelledby={`${id}-res`} value={String(value.resolution)}
          onValueChange={(r) => r && onChange({ ...value, resolution: Number(r) as StreamSettings["resolution"] })}>
          <ToggleGroupItem value="720">720p</ToggleGroupItem>
          <ToggleGroupItem value="1080">1080p</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="grid gap-1.5">
        <span id={`${id}-fps`} className="text-sm text-muted-foreground">Frame rate</span>
        <ToggleGroup type="single" variant="outline" aria-labelledby={`${id}-fps`} value={String(value.fps)}
          onValueChange={(f) => f && onChange({ ...value, fps: Number(f) as StreamSettings["fps"] })}>
          <ToggleGroupItem value="30">30 fps</ToggleGroupItem>
          <ToggleGroupItem value="60">60 fps</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={`${id}-audio`}>Share audio</Label>
        <Switch id={`${id}-audio`} checked={value.audio} onCheckedChange={(audio) => onChange({ ...value, audio })} />
      </div>
    </div>
  );
}
