import type { Member, Role } from "@datrope/core";
import { Copy, MessageCircle, UserRound } from "lucide-react";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { RefButton } from "@/components/ref-button";
import { UserAvatar } from "@/components/user-avatar";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { client, displayName, roleColor, useApp } from "../session";
import { EmojiText } from "@/chat/EmojiText";
import { GuestBadge } from "@/components/guest-badge";
import { ProfilePopover } from "./people/ProfilePopover";
import { MemberRoleIcon } from "@/components/role-icon";
import { ActivityLine } from "@/components/activity";
import { openProfile } from "./side-panel/panel";

const rank: Record<string, number> = { online: 2, idle: 1 };

interface Group {
  key: string;
  name: string;
  members: Member[];
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
  // Who is in a server voice channel, by user ID: the channel's name (a DM call is left out).
  const inVoice = useApp(useShallow((s) => Object.fromEntries(Object.values(s.voice).flatMap((v) => {
    const ch = v.channel_id ? s.channels[v.channel_id] : undefined;
    return ch && ch.type !== "dm" ? [[v.user_id, ch.name]] : [];
  }))));
  const { groups, colors, total } = useMemo(() => {
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
    return { groups: [...hoisted.values(), online, offline].filter((g) => g.members.length > 0), colors, total: members.length };
  }, [sv, presences]);

  return (
    <aside className={cn("w-[240px] flex-none overflow-y-auto border-l bg-card p-3", sheet ? "h-full w-full border-l-0" : "max-[760px]:hidden")} aria-label="Members">
      <h3 className="sr-only">Members — {total}</h3>
      {groups.map((g) => (
        <section key={g.key} aria-label={g.name} className="mb-3">
          <h3>{g.name} — {g.members.length}</h3>
          <ul className="mt-1 list-none">
            {g.members.map((m) => {
              const status = presences[m.user.id] ?? "offline";
              const activity = activities[m.user.id];
              const line = activity ? <ActivityLine activity={activity} /> : m.user.custom_status ? <EmojiText text={m.user.custom_status} /> : inVoice[m.user.id] ? `In voice: ${inVoice[m.user.id]}` : undefined;
              return (
              <ContextMenu modal={false} key={m.user.id}>
              <ContextMenuTrigger asChild>
              <li>
                <ProfilePopover userId={m.user.id} side="left" disabled={sheet}>
                  <RefButton variant="ghost" aria-label={displayName(m.user)}
                    onClick={sheet ? () => openProfile(m.user.id) : undefined}
                    className={cn("h-auto w-full justify-start gap-2.5 px-2 py-1.5 text-left font-normal", status === "offline" && "opacity-50")}>
                    <UserAvatar user={m.user} size="md" status={status} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1 truncate" style={{ color: colors[m.user.id] }}>
                        <span className="truncate">{displayName(m.user)}</span><MemberRoleIcon userId={m.user.id} /><GuestBadge user={m.user} />
                      </span>
                      {line && <span className="block truncate text-xs text-muted-foreground">{line}</span>}
                    </span>
                  </RefButton>
                </ProfilePopover>
              </li>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
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
            })}
          </ul>
        </section>
      ))}
    </aside>
  );
}
