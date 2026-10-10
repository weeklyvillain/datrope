import {
  Perm, channelGroups, hasPerm, myBasePerms, myChannelPerms, unwrap, type Category, type Channel,
} from "@datrope/core";
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, pointerWithin, useDroppable, useSensor, useSensors,
  type Announcements, type CollisionDetection, type DragEndEvent, type DragOverEvent, type DragStartEvent, type UniqueIdentifier,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CheckCheck, Link2, Phone, Settings } from "lucide-react";
import {
  createContext, useContext, useEffect, useMemo, useRef, useState,
  type CSSProperties, type HTMLAttributes, type ReactNode, type Ref,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useCollapsed } from "@/lib/collapsed";
import { cn } from "@/lib/utils";
import { client, errorText, isUnread, useApp, userName } from "../../session";
import { channelIcon, isUnreadType } from "../channel-types";
import { CategoryDialog, DeleteCategoryDialog } from "../dialogs/CategoryDialog";
import { ChannelSettingsDialog } from "../dialogs/ChannelSettingsDialog";
import { CreateChannelDialog } from "../dialogs/CreateChannelDialog";
import { voice } from "../../voice/voice";
import { VoiceMembers } from "../voice/VoiceMembers";
import { CategoryHeader, type CategoryAction } from "./CategoryHeader";
import { EmojiText } from "@/chat/EmojiText";
import { NONE, groupOf, moveTo, type Groups } from "./order";

// Drag IDs: "ch:<channel>", "cat:<category>", and "group:<category or NONE>" for an empty group's drop area;
// "vm:<user>" for someone in voice, dropped on "vc:<voice channel>" to move them there.
type Kind = "ch" | "cat" | "group" | "vm" | "vc";
const kindOf = (id: UniqueIdentifier) => String(id).split(":")[0] as Kind;
const rawId = (id: UniqueIdentifier) => String(id).slice(String(id).indexOf(":") + 1);

// Someone in voice lands on the voice channel under the pointer; everything else sorts.
const collision: CollisionDetection = (args) => kindOf(args.active.id) === "vm"
  ? pointerWithin({ ...args, droppableContainers: args.droppableContainers.filter((c) => kindOf(c.id) === "vc") })
  : closestCenter(args);

interface Layout {
  welcomeId?: string;
  groups: Groups; // NONE leaves out the welcome channel, which never moves
  cats: string[]; // category IDs by position
}

interface Tree {
  activeId?: string;
  dragKind?: Kind;
  dragId?: string;
  canManage: boolean;
  manageable: string[];
  openSettings: (id: string) => void;
  justDropped: () => boolean; // the click that ends a pointer drag is not a click
}

const TreeContext = createContext<Tree | null>(null);
const useTree = () => useContext(TreeContext)!;

/** The sidebar's channel list: uncategorised channels, then categories; managers drag to reorder. */
export function ChannelTree({ activeId }: { activeId?: string }) {
  const channelIds = useApp((s) => s.server?.channelIds);
  const categories = useApp((s) => s.server?.categories);
  const channels = useApp((s) => s.channels);
  const canManage = useApp((s) => hasPerm(myBasePerms(s), Perm.ManageChannels));
  const manageable = useApp(useShallow((s) =>
    (s.server?.channelIds ?? []).filter((id) => hasPerm(myChannelPerms(s, id), Perm.ManageChannels))));

  const base = useMemo<Layout>(() => {
    const g = channelGroups(client.store.getState());
    const welcomeId = g.uncategorised.find((id) => channels[id]?.type === "welcome");
    const groups: Groups = { [NONE]: g.uncategorised.filter((id) => id !== welcomeId) };
    for (const c of g.categories) groups[c.category.id] = c.channelIds;
    return { welcomeId, groups, cats: g.categories.map((c) => c.category.id) };
  }, [channelIds, categories, channels]);

  const [drag, setDrag] = useState<Layout & { id: UniqueIdentifier }>();
  const view = drag ?? base;
  const [settingsFor, setSettingsFor] = useState<string>();
  const [dialog, setDialog] = useState<{ action: CategoryAction; category: Category }>();
  const [error, setError] = useState<string>();
  const errorTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(errorTimer.current), []);
  const droppedAt = useRef(0);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Space picks up and drops; Enter still follows links and toggles categories.
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  const label = (id: UniqueIdentifier) => {
    const raw = rawId(id);
    if (kindOf(id) === "vm") return userName(client.store.getState(), raw);
    if (kindOf(id) === "ch" || kindOf(id) === "vc") return `#${channels[raw]?.name ?? ""}`;
    if (raw === NONE) return "channels without a category";
    return `category ${categories?.[raw]?.name ?? ""}`;
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${label(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `${label(active.id)} is over ${label(over.id)}.` : `${label(active.id)} is not over a place to drop.`),
    onDragEnd: ({ active, over }) => (over ? `${label(active.id)} was dropped on ${label(over.id)}.` : `${label(active.id)} was dropped.`),
    onDragCancel: ({ active }) => `Moving ${label(active.id)} was cancelled.`,
  };

  const showError = (e: unknown) => {
    setError(errorText(e));
    clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(undefined), 5000);
  };
  const fail = (e: unknown) => {
    showError(e);
    void reload();
  };

  const onDragStart = ({ active }: DragStartEvent) => setDrag({ ...base, id: active.id });

  // A channel joins another group while it is dragged, so that group's rows make room.
  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over || kindOf(active.id) !== "ch") return;
    const id = rawId(active.id);
    setDrag((d) => {
      if (!d) return d;
      const from = groupOf(d.groups, id);
      const intoEmpty = kindOf(over.id) === "group";
      const to = intoEmpty ? rawId(over.id) : groupOf(d.groups, rawId(over.id));
      if (!from || !to || from === to || !(to in d.groups)) return d;
      const index = intoEmpty ? d.groups[to].length : d.groups[to].indexOf(rawId(over.id));
      return { ...d, groups: moveTo(d.groups, id, to, index) };
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const d = drag;
    setDrag(undefined);
    droppedAt.current = Date.now();
    if (!d || !over) return;
    if (kindOf(active.id) === "vm") {
      const to = rawId(over.id);
      if (kindOf(over.id) === "vc" && to !== active.data.current?.from) void client.moveVoice(rawId(active.id), to).catch(showError);
      return;
    }
    if (kindOf(active.id) === "cat") {
      const from = d.cats.indexOf(rawId(active.id));
      const to = d.cats.indexOf(rawId(over.id));
      if (from < 0 || to < 0 || from === to) return;
      void moveCategory(rawId(active.id), arrayMove(d.cats, from, to), to).catch(fail);
      return;
    }
    const id = rawId(active.id);
    const group = groupOf(d.groups, id);
    if (!group) return;
    let groups = d.groups;
    if (kindOf(over.id) === "ch" && groupOf(groups, rawId(over.id)) === group) {
      groups = moveTo(groups, id, group, groups[group].indexOf(rawId(over.id)));
    }
    const index = groups[group].indexOf(id);
    const was = groupOf(base.groups, id) ?? group;
    if (was === group && base.groups[group].indexOf(id) === index) return;
    // Uncategorised positions count the welcome channel, which stays first: nothing lands above it.
    const welcome = base.welcomeId ? 1 : 0;
    const position = group === NONE ? index + welcome : index;
    void moveChannel(id, groups, [...new Set([was, group])], group, position, welcome).catch(fail);
  };

  const tree: Tree = {
    activeId, canManage, manageable,
    dragKind: drag ? kindOf(drag.id) : undefined,
    dragId: drag ? rawId(drag.id) : undefined,
    openSettings: setSettingsFor,
    justDropped: () => Date.now() - droppedAt.current < 300,
  };
  const dragged = drag && kindOf(drag.id) === "ch" ? channels[rawId(drag.id)] : undefined;
  const draggedCat = drag && kindOf(drag.id) === "cat" ? categories?.[rawId(drag.id)] : undefined;
  const draggedUser = drag && kindOf(drag.id) === "vm" ? userName(client.store.getState(), rawId(drag.id)) : undefined;

  return (
    <TreeContext.Provider value={tree}>
      <DndContext sensors={sensors} collisionDetection={collision} accessibility={{ announcements }}
        onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => setDrag(undefined)}>
        <div className="p-2">
          <Group group={NONE} ids={view.groups[NONE] ?? []}>
            {view.welcomeId && <ChannelRow id={view.welcomeId} />}
          </Group>
          <SortableContext items={view.cats.map((c) => `cat:${c}`)} strategy={verticalListSortingStrategy}>
            {view.cats.map((catId) => {
              const category = categories?.[catId];
              const ids = view.groups[catId] ?? [];
              // Only managers see empty categories, to fill them.
              if (!category || (!canManage && ids.length === 0)) return null;
              return <CategorySection key={catId} category={category} ids={ids} onAction={(action) => setDialog({ action, category })} />;
            })}
          </SortableContext>
          <ErrorText error={error} />
        </div>
        <DragOverlay>
          {dragged && (
            <div className="flex items-center gap-2 rounded-md bg-accent px-2 py-1.5 text-foreground shadow-md">
              <ChannelIcon ch={dragged} />
              <span className="truncate">{dragged.name}</span>
            </div>
          )}
          {draggedCat && (
            <div className="rounded-md bg-accent px-2 py-1 text-xs font-semibold tracking-wide text-foreground uppercase shadow-md">{draggedCat.name}</div>
          )}
          {draggedUser && <div className="rounded-md bg-accent px-2 py-1 text-sm text-foreground shadow-md">{draggedUser}</div>}
        </DragOverlay>
      </DndContext>
      {settingsFor && <ChannelSettingsDialog channelId={settingsFor} onClose={() => setSettingsFor(undefined)} />}
      {dialog?.action === "create" && <CreateChannelDialog categoryId={dialog.category.id} onClose={() => setDialog(undefined)} />}
      {dialog?.action === "rename" && <CategoryDialog category={dialog.category} onClose={() => setDialog(undefined)} />}
      {dialog?.action === "delete" && <DeleteCategoryDialog category={dialog.category} onClose={() => setDialog(undefined)} />}
    </TreeContext.Provider>
  );
}

/** Puts the new order in the store (dense positions in the touched groups), then asks the server. */
async function moveChannel(id: string, groups: Groups, touched: string[], group: string, position: number, welcome: number) {
  const s = client.store.getState();
  for (const g of touched) {
    groups[g].forEach((cid, i) => {
      const ch = s.channels[cid];
      if (!ch) return;
      const { category_id: _old, ...rest } = ch;
      client.apply("CHANNEL_UPDATE", g === NONE ? { ...rest, position: i + welcome } : { ...rest, category_id: g, position: i });
    });
  }
  await client.moveChannel(id, { categoryId: group === NONE ? null : group, position });
}

async function moveCategory(id: string, order: string[], position: number) {
  const cats = client.store.getState().server?.categories ?? {};
  order.forEach((cid, i) => {
    if (cats[cid]) client.apply("CATEGORY_UPDATE", { ...cats[cid], position: i });
  });
  await client.updateCategory(id, { position });
}

/** After a failed move: the server's order again. */
async function reload() {
  await client.loadChannels().catch(() => undefined);
  const cats = await unwrap(client.api.GET("/api/server/categories")).catch(() => undefined);
  if (!cats) return;
  for (const c of cats) client.apply("CATEGORY_UPDATE", c);
  for (const id of Object.keys(client.store.getState().server?.categories ?? {})) {
    if (!cats.some((c) => c.id === id)) client.apply("CATEGORY_DELETE", { id });
  }
}

function CategorySection({ category, ids, onAction }: { category: Category; ids: string[]; onAction: (a: CategoryAction) => void }) {
  const { activeId, canManage, dragKind, dragId, justDropped } = useTree();
  const [collapsed, setCollapsed] = useCollapsed(category.id);
  const channels = useApp((s) => s.channels);
  const readStates = useApp((s) => s.readStates);
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({
    id: `cat:${category.id}`,
    disabled: !canManage || dragKind === "ch",
  });
  // Collapsed, it still shows the current channel, unread ones and one being dragged in.
  const shown = collapsed
    ? ids.filter((id) => id === activeId || id === dragId || (isUnreadType(channels[id]?.type) && isUnread(readStates[id])))
    : ids;
  return (
    <div ref={setNodeRef} role="group" aria-label={category.name} className={cn(isDragging && "opacity-40")}
      style={{ transform: CSS.Translate.toString(transform), transition }}>
      <CategoryHeader category={category} collapsed={collapsed} canManage={canManage} onAction={onAction}
        onToggle={() => !dragKind && !justDropped() && setCollapsed(!collapsed)}
        handle={canManage ? { ref: setActivatorNodeRef, ...listeners, "aria-describedby": attributes["aria-describedby"] } : undefined} />
      <Group group={category.id} ids={shown} />
    </div>
  );
}

/** A group's sortable channels, and a drop area while it shows none. */
function Group({ group, ids, children }: { group: string; ids: string[]; children?: ReactNode }) {
  const { canManage, dragKind } = useTree();
  const empty = ids.length === 0;
  const { setNodeRef } = useDroppable({ id: `group:${group}`, disabled: !canManage || dragKind !== "ch" || !empty });
  return (
    <ul ref={setNodeRef} className="list-none">
      {children}
      <SortableContext items={ids.map((id) => `ch:${id}`)} strategy={verticalListSortingStrategy}>
        {ids.map((id) => <SortableChannel key={id} id={id} />)}
      </SortableContext>
      {empty && dragKind === "ch" && (
        <li className="mx-1 my-0.5 rounded-md border border-dashed px-2 py-1.5 text-sm text-muted-foreground">Drop channels here</li>
      )}
    </ul>
  );
}

function SortableChannel({ id }: { id: string }) {
  const { manageable, dragKind } = useTree();
  const draggable = manageable.includes(id);
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({
    id: `ch:${id}`,
    disabled: !draggable || dragKind === "cat",
  });
  return (
    <ChannelRow id={id} itemRef={setNodeRef} className={cn(isDragging && "opacity-40")}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      handle={draggable ? { ref: setActivatorNodeRef, ...listeners, "aria-describedby": attributes["aria-describedby"] } : undefined} />
  );
}

function ChannelIcon({ ch }: { ch: Channel }) {
  const Icon = channelIcon(ch.type);
  return <Icon className="size-4 flex-none" aria-hidden />;
}

function ChannelRow({ id, itemRef, style, className, handle }: {
  id: string;
  itemRef?: Ref<HTMLLIElement>;
  style?: CSSProperties;
  className?: string;
  handle?: HTMLAttributes<HTMLAnchorElement> & { ref?: Ref<HTMLAnchorElement> };
}) {
  const { activeId, manageable, openSettings, justDropped, dragKind } = useTree();
  const ch = useApp((s) => s.channels[id]);
  const drop = useDroppable({ id: `vc:${id}`, disabled: dragKind !== "vm" || ch?.type !== "voice" });
  const unread = useApp((s) => isUnreadType(s.channels[id]?.type) && isUnread(s.readStates[id]));
  const canConnect = useApp((s) => hasPerm(myChannelPerms(s, id), Perm.ConnectVoice));
  const nav = useNavigate();
  const lastMessageId = useApp((s) => s.readStates[id]?.lastMessageId);
  if (!ch) return null;
  const active = id === activeId;
  return (
    <li ref={itemRef} style={style} className={className}>
      <ContextMenu modal={false}>
        <ContextMenuTrigger asChild>
        <div ref={drop.setNodeRef}
          className={cn("group flex items-center rounded-md hover:bg-accent", active && "bg-accent", drop.isOver && "bg-accent ring-1 ring-primary")}>
          <Link to={`/channels/${id}`} aria-current={active ? "page" : undefined} {...handle}
            onClick={(e) => {
              if (justDropped()) return e.preventDefault();
              if (ch.type === "voice" && canConnect) void voice.join(id); // clicking a voice channel joins it
            }}
            className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground no-underline hover:text-foreground",
              (active || unread || ch.type === "welcome") && "text-foreground", unread && "font-semibold")}>
            <ChannelIcon ch={ch} />
            <span className="truncate"><EmojiText text={ch.name} /></span>
          </Link>
          {manageable.includes(id) && (
            <Button variant="ghost" size="icon-xs" aria-label={`Settings for ${ch.name}`} title="Channel settings"
              className="mr-1 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
              onClick={() => openSettings(id)}><Settings /></Button>
          )}
        </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
          {unread && lastMessageId && (
            <ContextMenuItem onSelect={() => void client.ack(id, lastMessageId).catch(() => undefined)}><CheckCheck />Mark as read</ContextMenuItem>
          )}
          {ch.type === "voice" && canConnect && (
            <ContextMenuItem onSelect={() => { nav(`/channels/${id}`); void voice.join(id); }}><Phone />Join voice</ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(`${location.origin}/channels/${id}`).catch(() => undefined)}><Link2 />Copy link</ContextMenuItem>
          {manageable.includes(id) && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => openSettings(id)}><Settings />Channel settings</ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {ch.type === "voice" && <VoiceMembers channelId={id} name={ch.name} />}
    </li>
  );
}