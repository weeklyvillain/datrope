import type { Member, Role } from "@datrope/core";
import { Copy, MessageCircle, UserRound, X } from "lucide-react";
import { forwardRef, useMemo, useRef, type ComponentProps, type MutableRefObject, type ReactNode } from "react";
import { GroupedVirtuoso } from "react-virtuoso";
import { useNavigate, type NavigateFunction } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { SheetClose, SheetTitle } from "@/components/ui/sheet";
import { useArrowNav } from "@/hooks/use-arrow-nav";
import { useTitleBarClass, useTitleBarEdges } from "@/hooks/use-title-bar-edges";
import { RefButton } from "@/components/ref-button";
import { UserAvatar } from "@/components/user-avatar";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { restoreFocus } from "@/lib/focus";
import { client, displayName, roleColor, useApp } from "../session";
import { EmojiText } from "@/chat/EmojiText";
import { GuestBadge } from "@/components/guest-badge";
import { ProfilePopover } from "./people/ProfilePopover";
import { MemberRoleIcon } from "@/components/role-icon";
import { ActivityLine } from "@/components/activity";
import { openProfile } from "./side-panel/panel";
import { useChrome } from "./desktop-chrome";

// The list structure for screen readers; group headings sit between the items without a role.
const MemberItems = forwardRef<HTMLDivElement, ComponentProps<"div">>(({ children, ...props }, ref) => <div ref={ref} role="list" {...props}>{children}</div>);
MemberItems.displayName = "MemberItems";
const MemberItem = ({ children, ...props }: ComponentProps<"div">) => <div role="listitem" {...props}>{children}</div>;
// A group (heading) is a list item too; Virtuoso's sticky-group overlay is a plain wrapper.
const MemberTop = forwardRef<HTMLDivElement, ComponentProps<"div">>(({ children, ...props }, ref) => <div ref={ref} role="presentation" {...props}>{children}</div>);
MemberTop.displayName = "MemberTop";
const memberParts = { List: MemberItems, Item: MemberItem, Group: MemberItem, TopItemList: MemberTop };

const rank: Record<string, number> = { online: 2, idle: 1 };

interface Group {
  key: string;
  name: string;
  members: Member[];
}

/** The members slide-over's 56 px header band in the desktop app: its own close button, clear of the window buttons. */
export function MembersSheetBand() {
  const edges = useTitleBarEdges();
  const bandClass = useTitleBarClass("flex h-14 flex-none items-center gap-2 border-b pl-4 pr-2");
  return (
    <div ref={edges} data-titlebar-drag className={bandClass}>
      <SheetTitle className="min-w-0 flex-1 truncate text-body">Members</SheetTitle>
      <SheetClose asChild>
        <RefButton variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Close members" title="Close"><X /></RefButton>
      </SheetClose>
    </div>
  );
}

/**
 * The server's members: those with a hoisted role under their highest hoisted role (in role order),
 * then everyone else as Online / Offline. Names take the colour of their highest coloured role.
 */
export function MemberList({ sheet = false }: { sheet?: boolean } = {}) {
  const sv = useApp((s) => s.server);
  const presences = useApp((s) => s.presences);
  const activities = useApp((s) => s.activities);
  const meId = useApp((s) => s.me?.id);
  const nav = useNavigate();
  const rows = useRef<Record<string, HTMLDivElement | null>>({});
  const asideRef = useRef<HTMLElement>(null);
  useArrowNav(asideRef, "[data-member-row]");
  // In the desktop app the docked list starts with a 56 px band, so the window buttons have room above it.
  const banded = useChrome((s) => s.claimed) && !sheet;
  const edges = useTitleBarEdges();
  const bandClass = useTitleBarClass("flex h-14 flex-none items-center border-b bg-topbar px-3");
  // Who is in a server voice channel, by user ID: the channel's name (a DM call is left out).
  const inVoice = useApp(useShallow((s) => Object.fromEntries(Object.values(s.voice).flatMap((v) => {
    const ch = v.channel_id ? s.channels[v.channel_id] : undefined;
    return ch && ch.type !== "dm" ? [[v.user_id, ch.name]] : [];
  }))));
  const { groups, flat, colors, total } = useMemo(() => {
    const ranked: Role[] = Object.values(sv?.roles ?? {}).filter((r) => r.id !== sv?.server.id).sort((a, b) => b.position - a.position);
    const members = Object.values(sv?.members ?? {}).sort((a, b) =>
      (rank[presences[b.user.id] ?? ""] ?? 0) - (rank[presences[a.user.id] ?? ""] ?? 0) ||
      displayName(a.user).localeCompare(displayName(b.user)));
    const hoisted = new Map<string, Group>(ranked.filter((r) => r.hoist).map((r) => [r.id, { key: r.id, name: r.name, members: [] }]));
    const online: Group = { key: "online", name: "Online", members: [] };
    const offline: Group = { key: "offline", name: "Offline", members: [] };
    const colors: Record<string, string | undefined> = {};
    for (const m of members) {
      const mine = ranked.filter((r) => (m.role_ids ?? []).includes(r.id));
      colors[m.user.id] = roleColor(sv, m.user.id);
      const top = mine.find((r) => r.hoist);
      (top ? hoisted.get(top.id)! : presences[m.user.id] && presences[m.user.id] !== "offline" ? online : offline).members.push(m);
    }
    const groups = [...hoisted.values(), online, offline].filter((g) => g.members.length > 0);
    return { groups, flat: groups.flatMap((g) => g.members), colors, total: members.length };
  }, [sv, presences]);

  return (
    <aside ref={asideRef} className={cn("flex w-[240px] flex-none flex-col border-l bg-card", sheet ? "min-h-0 w-full flex-1 border-l-0" : undefined)} aria-label="Members">
      {banded ? (
        <div ref={edges} data-titlebar-drag className={bandClass}><h2 className="text-sm font-semibold">Members — {total}</h2></div>
      ) : <h3 className="sr-only">Members — {total}</h3>}
      <div className="min-h-0 flex-1">
        <GroupedVirtuoso className="h-full" components={memberParts}
          computeItemKey={(index) => flat[index]?.user.id ?? index}
          groupCounts={groups.map((g) => g.members.length)}
          groupContent={(gi) => <h3 className="bg-card px-3 pt-3 pb-1">{groups[gi]!.name} — {groups[gi]!.members.length}</h3>}
          itemContent={(index) => {
            const m = flat[index]!;
            const activity = activities[m.user.id];
            const line = activity ? <ActivityLine activity={activity} /> : m.user.custom_status ? <EmojiText text={m.user.custom_status} /> : inVoice[m.user.id] ? `In voice: ${inVoice[m.user.id]}` : undefined;
            return <MemberRow m={m} status={presences[m.user.id] ?? "offline"} line={line} color={colors[m.user.id]} sheet={sheet} meId={meId} nav={nav} rows={rows} />;
          }} />
      </div>
    </aside>
  );
}

function MemberRow({ m, status, line, color, sheet, meId, nav, rows }: {
  m: Member; status: string; line: ReactNode; color?: string; sheet: boolean; meId?: string;
  nav: NavigateFunction; rows: MutableRefObject<Record<string, HTMLDivElement | null>>;
}) {
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
        <div ref={(el) => { rows.current[m.user.id] = el; }} className="px-3">
          <ProfilePopover userId={m.user.id} side="left" disabled={sheet}>
            <RefButton variant="ghost" data-member-row="" aria-label={displayName(m.user)}
              onClick={sheet ? () => openProfile(m.user.id) : undefined}
              className={cn("h-auto min-h-11 w-full justify-start gap-2.5 px-2 py-1.5 text-left font-normal")}>
              <UserAvatar user={m.user} size="md" status={status} className={status === "offline" ? "opacity-60" : undefined} />
              <span className="min-w-0 flex-1">
                <span className={cn("flex items-center gap-1 truncate", status === "offline" && "text-muted-foreground")} style={{ color: status === "offline" ? undefined : color }}>
                  <span className="truncate">{displayName(m.user)}</span><MemberRoleIcon userId={m.user.id} /><GuestBadge user={m.user} />
                </span>
                {line && <span className="block truncate text-xs text-muted-foreground">{line}</span>}
              </span>
            </RefButton>
          </ProfilePopover>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52" onCloseAutoFocus={(e) => restoreFocus(e, rows.current[m.user.id] ?? null)}>
        <ContextMenuItem onSelect={() => openProfile(m.user.id)}><UserRound />View profile</ContextMenuItem>
        {m.user.id !== meId && (
          <ContextMenuItem onSelect={() => void client.openDM(m.user.id).then((ch) => nav(`/messages/${ch.id}`), () => undefined)}>
            <MessageCircle />Message
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(m.user.id).catch(() => undefined)}><Copy />Copy user ID</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
