import { AppWindow, Gamepad2, Monitor, Type } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { withMode, type StreamMode, type StreamSettings } from "@/voice/stream-prefs";
import type { ScreenPickRequest, ScreenSource } from "./rail-api";

/**
 * Chooses what a server page shares and, when going live, the stream quality. It lives in the shell's chrome, not
 * the page, so a server only ever gets the screen or window the user picked here.
 */
export function ScreenPicker({ request, onDone }: {
  request: ScreenPickRequest | undefined;
  onDone: (id: string | null, settings: StreamSettings | null) => void;
}) {
  const [chosen, setChosen] = useState<string>();
  // The quality as changed here; the request's until then.
  const [edited, setEdited] = useState<StreamSettings>();
  const settings = request?.settings ? edited ?? request.settings : null;
  const screens = request?.sources.filter((s) => s.kind === "screen") ?? [];
  const windows = request?.sources.filter((s) => s.kind === "window") ?? [];
  const goLive = !!request?.settings;

  function finish(id: string | null) {
    setChosen(undefined);
    setEdited(undefined);
    onDone(id, id ? settings : null);
  }

  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && finish(null)}>
      <DialogContent className="sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>{goLive ? "Go Live" : "Share your screen"}</DialogTitle>
          <DialogDescription>{request?.server || "This server"} will see what you pick.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="screens">
          <TabsList>
            <TabsTrigger value="screens">Screens</TabsTrigger>
            <TabsTrigger value="windows">Windows</TabsTrigger>
          </TabsList>
          <TabsContent value="screens"><SourceGrid sources={screens} chosen={chosen} onChoose={setChosen} onShare={finish} /></TabsContent>
          <TabsContent value="windows"><SourceGrid sources={windows} chosen={chosen} onChoose={setChosen} onShare={finish} /></TabsContent>
        </Tabs>
        <DialogFooter className="border-t pt-4 sm:items-center">
          {settings && <QualityFields value={settings} onChange={setEdited} />}
          <span className="hidden grow sm:block" />
          <Button variant="outline" onClick={() => finish(null)}>Cancel</Button>
          <Button disabled={!chosen} onClick={() => chosen && finish(chosen)}>{goLive ? "Go Live" : "Share"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const MODES: { value: StreamMode; label: string; hint: string; icon: typeof Gamepad2 }[] = [
  { value: "game", label: "Game", hint: "Smooth motion, 60 fps", icon: Gamepad2 },
  { value: "detail", label: "Detail", hint: "Sharp text, for code and documents", icon: Type },
];

/** Mode, resolution and frame rate, compact beside the buttons. The app's capture has no audio yet. */
function QualityFields({ value, onChange }: { value: StreamSettings; onChange: (s: StreamSettings) => void }) {
  const mode = MODES.find((m) => m.value === value.mode)!;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={value.mode} onValueChange={(m) => onChange(withMode(value, m as StreamMode))}>
        {/* Without the hint the items carry. */}
        <SelectTrigger size="sm" aria-label="Mode"><SelectValue><mode.icon /> {mode.label}</SelectValue></SelectTrigger>
        <SelectContent>
          {MODES.map((m) => (
            <SelectItem key={m.value} value={m.value} textValue={m.label}>
              <m.icon />
              <span className="grid">
                {m.label}
                <span className="text-xs text-muted-foreground">{m.hint}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={String(value.resolution)}
        onValueChange={(r) => onChange({ ...value, resolution: Number(r) as StreamSettings["resolution"] })}>
        <SelectTrigger size="sm" aria-label="Resolution"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="720">720p</SelectItem>
          <SelectItem value="1080">1080p</SelectItem>
        </SelectContent>
      </Select>
      <Select value={String(value.fps)} onValueChange={(f) => onChange({ ...value, fps: Number(f) as StreamSettings["fps"] })}>
        <SelectTrigger size="sm" aria-label="Frame rate"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="30">30 fps</SelectItem>
          <SelectItem value="60">60 fps</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function SourceGrid({ sources, chosen, onChoose, onShare }: {
  sources: ScreenSource[];
  chosen: string | undefined;
  onChoose: (id: string) => void;
  onShare: (id: string) => void;
}) {
  if (sources.length === 0) return <p className="m-0 py-8 text-center text-sm text-muted-foreground">Nothing to share here.</p>;
  return (
    <div role="listbox" aria-label="Sources" className="grid max-h-[50vh] grid-cols-2 gap-3 overflow-y-auto p-1 sm:grid-cols-3">
      {sources.map((s) => {
        const Icon = s.kind === "screen" ? Monitor : AppWindow;
        return (
          <button key={s.id} type="button" role="option" aria-selected={chosen === s.id} title={s.name}
            onClick={() => onChoose(s.id)} onDoubleClick={() => onShare(s.id)}
            className={cn(
              "grid min-w-0 gap-1.5 rounded-lg border border-border p-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
              chosen === s.id && "border-primary bg-accent",
            )}>
            <span className="flex aspect-video items-center justify-center overflow-hidden rounded-md bg-muted">
              {s.thumbnail
                ? <img src={s.thumbnail} alt="" className="size-full object-contain" />
                : <Icon className="size-8 text-muted-foreground" />}
            </span>
            <span className="flex min-w-0 items-center gap-1.5 text-sm">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{s.name}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
