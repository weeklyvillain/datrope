import { useId, useMemo } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { useApp } from "../../session";
import { channelIcon } from "../channel-types";

export type SourcesValue = { mode: "none" | "all" | "selected"; ids: string[] };

const SOURCE_TYPES = new Set(["text", "voice", "webhook", "announcement", "forum", "gallery"]);

const MODES: { value: SourcesValue["mode"]; label: string; description: string }[] = [
  { value: "none", label: "Only this gallery", description: "Just what people post here." },
  { value: "all", label: "Every channel", description: "Plus posts here. New channels join automatically." },
  { value: "selected", label: "Channels I pick", description: "Plus posts here." },
];

/** The create and update request fields for a gallery's sources. */
export function sourcesBody(v: SourcesValue): { gallery_sources: SourcesValue["mode"]; source_channel_ids?: string[] } {
  return v.mode === "selected" ? { gallery_sources: "selected", source_channel_ids: v.ids } : { gallery_sources: v.mode };
}

/** "Show files from": a gallery's sources as three radio cards; "Channels I pick" opens a checklist by category. */
export function GallerySourcesField({ value, onChange, selfId }: { value: SourcesValue; onChange: (v: SourcesValue) => void; selfId?: string }) {
  const id = useId();
  const channels = useApp((s) => s.channels);
  const order = useApp((s) => s.server?.channelIds);
  const categories = useApp((s) => s.server?.categories);
  const groups = useMemo(() => {
    const eligible = (order ?? []).map((cid) => channels[cid]).filter((c) => c && c.id !== selfId && SOURCE_TYPES.has(c.type));
    const cats = Object.values(categories ?? {}).sort((a, b) => a.position - b.position);
    return [
      { id: "", name: "", items: eligible.filter((c) => !c.category_id) },
      ...cats.map((cat) => ({ id: cat.id, name: cat.name, items: eligible.filter((c) => c.category_id === cat.id) })),
    ].filter((g) => g.items.length > 0);
  }, [order, channels, categories, selfId]);
  const toggle = (cid: string, on: boolean) =>
    onChange({ mode: "selected", ids: on ? [...value.ids, cid] : value.ids.filter((x) => x !== cid) });

  return (
    <div className="grid gap-2">
      <span id={`${id}-label`} className="text-sm font-medium">Show files from</span>
      <RadioGroup aria-labelledby={`${id}-label`} value={value.mode} onValueChange={(v) => onChange({ ...value, mode: v as SourcesValue["mode"] })} className="gap-2">
        {MODES.map((m) => (
          <Label key={m.value} htmlFor={`${id}-${m.value}`}
            className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal", value.mode === m.value ? "border-primary bg-accent" : "hover:bg-accent/50")}>
            <RadioGroupItem value={m.value} id={`${id}-${m.value}`} className="mt-0.5" />
            <span className="grid gap-0.5">
              <span className="font-medium">{m.label}</span>
              <span className="text-xs text-muted-foreground">{m.description}</span>
            </span>
          </Label>
        ))}
      </RadioGroup>
      {value.mode === "selected" && (
        <div role="group" aria-label="Channels" className="grid max-h-56 gap-3 overflow-y-auto rounded-lg border p-3">
          {groups.map((g) => (
            <div key={g.id} className="grid gap-1.5">
              {g.name && <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g.name}</span>}
              {g.items.map((c) => {
                const Icon = channelIcon(c.type);
                return (
                  <div key={c.id} className="flex items-center gap-2">
                    <Checkbox id={`${id}-c-${c.id}`} checked={value.ids.includes(c.id)} onCheckedChange={(on) => toggle(c.id, on === true)} />
                    <Label htmlFor={`${id}-c-${c.id}`} className="flex items-center gap-1.5 font-normal">
                      <Icon className="size-4 text-muted-foreground" aria-hidden />{c.name}
                    </Label>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {value.mode === "selected" && value.ids.length === 0 && <p className="m-0 text-xs text-muted-foreground">Pick at least one channel.</p>}
      <p className="m-0 text-xs text-muted-foreground">People only see files from channels they can read.</p>
    </div>
  );
}
