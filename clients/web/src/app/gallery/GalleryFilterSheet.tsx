import { useId, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ActionSheet } from "@/components/action-sheet";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ChannelFilter } from "./ChannelFilter";
import type { GalleryFilter } from "./filter";

export type GallerySegment = "files" | "albums" | "music";

/** Phones' full-width view switch: All files, Albums (its own route) and Music (the audio kind). */
export function GallerySegments({ value, onFiles, onMusic }: { value: GallerySegment; onFiles?: () => void; onMusic?: () => void }) {
  const nav = useNavigate();
  const go = (v: string) => {
    if (!v || v === value) return; // a click on the selected segment reports ""
    if (v === "albums") nav("/gallery/albums");
    else if (v === "music") {
      if (onMusic) onMusic();
      else nav("/gallery?kind=audio");
    } else if (onFiles) onFiles();
    else nav("/gallery");
  };
  return (
    <ToggleGroup type="single" variant="outline" aria-label="Gallery view" value={value} onValueChange={go}
      className="mx-4 mt-3 mb-1 w-[calc(100%-2rem)] flex-none">
      {([["files", "All files"], ["albums", "Albums"], ["music", "Music"]] as const).map(([v, label]) => (
        <ToggleGroupItem key={v} value={v} aria-label={label} className="h-9 flex-1 text-ui font-normal text-muted-foreground data-[state=on]:font-semibold data-[state=on]:text-foreground">{label}</ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** Phones' filter sheet: the channel and uploader filters that don't fit the header. */
export function GalleryFilterSheet({ open, onOpenChange, filter, setFilter, global, uploaders }: {
  open: boolean; onOpenChange: (open: boolean) => void; filter: GalleryFilter; setFilter: (patch: Partial<GalleryFilter>) => void;
  global: boolean; uploaders: (readonly [string, string])[];
}) {
  const uploaderId = useId();
  const row = (children: ReactNode) => <div className="flex items-center justify-between gap-3">{children}</div>;
  return (
    <ActionSheet open={open} onOpenChange={onOpenChange} title="Filter files" role="group">
      <div className="grid gap-4 px-2 py-3">
        {global && row(<>
          <span className="text-ui text-muted-foreground">Channel</span>
          <ChannelFilter value={filter.channels} onChange={(channels) => setFilter({ channels })} />
        </>)}
        {row(<>
          <label htmlFor={uploaderId} className="text-ui text-muted-foreground">Uploaded by</label>
          <NativeSelect id={uploaderId} value={filter.uploader ?? ""} onChange={(e) => setFilter({ uploader: e.target.value || null })}>
            <NativeSelectOption value="">Anyone</NativeSelectOption>
            {uploaders.map(([id, name]) => <NativeSelectOption key={id} value={id}>{name}</NativeSelectOption>)}
          </NativeSelect>
        </>)}
        <Button onClick={() => onOpenChange(false)}>Done</Button>
      </div>
    </ActionSheet>
  );
}
