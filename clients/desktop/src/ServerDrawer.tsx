import type { ReactNode } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Plus } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { mentionLabel, serverInitials } from "./order";
import type { RailServer } from "./rail-api";

function ServerRow({ s, selected, onPick, onMenu }: {
  s: RailServer;
  selected: boolean;
  onPick: (s: RailServer) => void;
  onMenu: (s: RailServer) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: s.id });
  const label = `${s.name}${s.mentions ? `, ${s.mentions} mentions` : s.unread ? ", unread messages" : ""}${s.online ? "" : ", can't reach"}`;
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("relative", isDragging && "z-10 opacity-80")}>
      <button type="button" aria-label={label} aria-current={selected ? "page" : undefined} title={s.name}
        onClick={() => onPick(s)}
        onContextMenu={(e) => { e.preventDefault(); onMenu(s); }}
        {...attributes} {...listeners}
        className={cn(buttonVariants({ variant: "ghost" }), "h-11 w-full justify-start gap-3 px-2 font-normal text-muted-foreground hover:text-foreground",
          selected && "bg-accent text-foreground", !s.online && "opacity-50 grayscale")}>
        <span aria-hidden className={cn("flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-card text-xs font-semibold text-foreground",
          selected && "bg-primary text-primary-foreground")}>
          {s.icon ? <img src={s.icon} alt="" className="size-full object-cover" /> : serverInitials(s.name)}
        </span>
        <span className={cn("grow truncate", (s.unread || s.mentions > 0) && "font-semibold text-foreground")}>{s.name}</span>
        {s.mentions > 0 ? (
          <span aria-hidden className="min-w-5 rounded-full bg-destructive px-1.5 text-center text-[11px] leading-5 font-semibold text-destructive-foreground">
            {mentionLabel(s.mentions)}
          </span>
        ) : s.unread ? (
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-foreground" />
        ) : null}
      </button>
    </li>
  );
}

/** The server list in the drawer webview: pick, drag to reorder, right-click to remove, add another. */
export function ServerDrawer({ header, servers, selected, onPick, onMenu, onReorder, onAdd }: {
  /** Rendered first in the drawer, e.g. its own header when the shell bar is hidden. */
  header?: ReactNode;
  servers: RailServer[];
  selected: string | null;
  onPick: (s: RailServer) => void;
  onMenu: (s: RailServer) => void;
  onReorder: (active: string, over: string) => void;
  onAdd: () => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function dragEnd(e: DragEndEvent) {
    if (e.over) onReorder(String(e.active.id), String(e.over.id));
  }

  return (
    <nav id="server-drawer" aria-label="Servers"
      className="flex h-full w-[260px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-border bg-sidebar p-2">
      {header}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
        <SortableContext items={servers.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {servers.map((s) => (
              <ServerRow key={s.id} s={s} selected={s.id === selected} onPick={onPick} onMenu={onMenu} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <Button variant="ghost" className="justify-start gap-3 px-2 text-primary hover:text-primary" onClick={onAdd}>
        <span aria-hidden className="flex size-8 items-center justify-center rounded-lg bg-card"><Plus className="size-4" /></span>
        Add a server
      </Button>
    </nav>
  );
}
