import { AppWindow, Monitor } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { ScreenPickRequest, ScreenSource } from "./rail-api";

/**
 * Chooses what a server page shares. It lives in the shell's chrome, not the page, so a server only ever gets the
 * screen or window the user picked here.
 */
export function ScreenPicker({ request, onDone }: {
  request: ScreenPickRequest | undefined;
  onDone: (id: string | null) => void;
}) {
  const [chosen, setChosen] = useState<string>();
  const screens = request?.sources.filter((s) => s.kind === "screen") ?? [];
  const windows = request?.sources.filter((s) => s.kind === "window") ?? [];

  function finish(id: string | null) {
    setChosen(undefined);
    onDone(id);
  }

  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && finish(null)}>
      <DialogContent className="sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>Share your screen</DialogTitle>
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
        <DialogFooter>
          <Button variant="outline" onClick={() => finish(null)}>Cancel</Button>
          <Button disabled={!chosen} onClick={() => chosen && finish(chosen)}>Share</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
