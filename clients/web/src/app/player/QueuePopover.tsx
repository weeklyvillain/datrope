import { DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, Ellipsis, GripVertical, ListMusic, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RefButton } from "@/components/ref-button";
import { player, usePlayer } from "./player-store";
import type { Track } from "./queue";
import { BareButton } from "@/components/bare-button";

export function QueuePopover() {
  const queue = usePlayer((s) => s.queue);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const current = queue.tracks[queue.index];
  const upNext = queue.tracks.slice(queue.index + 1);
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const keys = queue.tracks.map((t) => t.key);
    player.move(keys.indexOf(String(e.active.id)), keys.indexOf(String(e.over.id)));
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <RefButton variant="ghost" size="icon-sm" aria-label="Queue"><ListMusic /></RefButton>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80 p-0" aria-label="Queue">
        <div className="flex items-center px-3 pt-2.5 pb-1">
          <span className="flex-1 text-sm font-semibold">Queue</span>
          <Button variant="ghost" size="sm" onClick={() => player.clear()}>Clear queue</Button>
        </div>
        <p className="m-0 px-3 pt-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Now playing</p>
        {current && <div className="mx-1 truncate rounded-md bg-accent px-2 py-1.5 text-sm font-semibold text-primary">{current.title}</div>}
        <p className="m-0 px-3 pt-3 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Up next · {upNext.length}</p>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={upNext.map((t) => t.key)} strategy={verticalListSortingStrategy}>
            <ol className="m-0 grid max-h-72 list-none gap-0.5 overflow-y-auto p-1">
              {upNext.map((t, i) => <Row key={t.key} track={t} index={queue.index + 1 + i} first={i === 0} last={i === upNext.length - 1} />)}
            </ol>
          </SortableContext>
        </DndContext>
      </PopoverContent>
    </Popover>
  );
}

function Row({ track, index, first, last }: { track: Track; index: number; first: boolean; last: boolean }) {
  const s = useSortable({ id: track.key });
  return (
    <li ref={s.setNodeRef} style={{ transform: CSS.Transform.toString(s.transform), transition: s.transition }}
      className="group flex items-center gap-1.5 rounded-md px-1 py-1 hover:bg-accent">
      <BareButton aria-label={`Move ${track.title}`} className="cursor-grab touch-none text-muted-foreground" {...s.attributes} {...s.listeners}><GripVertical className="size-4" /></BareButton>
      <span className="min-w-0 flex-1"><span className="block truncate text-sm">{track.title}</span><span className="block truncate text-xs text-muted-foreground">{track.subtitle}</span></span>
      <TrackMenu track={track} index={index} first={first} last={last} />
    </li>
  );
}

/** An upcoming track's ⋯ menu: Move up, Move down, Remove. Also in the phone's full-screen player. */
export function TrackMenu({ track, index, first, last, className }: { track: Track; index: number; first: boolean; last: boolean; className?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <RefButton variant="ghost" size="icon-sm" className={className} aria-label={`Options for ${track.title}`}><Ellipsis /></RefButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={first} onSelect={() => player.move(index, index - 1)}><ArrowUp />Move up</DropdownMenuItem>
        <DropdownMenuItem disabled={last} onSelect={() => player.move(index, index + 1)}><ArrowDown />Move down</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => player.remove(index)}><X />Remove</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
