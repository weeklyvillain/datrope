import { Perm, canCreateInvites, hasPerm, sidebarChannelIds, unwrap, type Member } from "@datrope/core";
import { BookOpen, CheckCheck, Hash, Keyboard, PhoneOff, Plus, Search, Settings, User, UserPlus, Users, Volume2, type AnimatedIcon } from "@/components/icons";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { ErrorText } from "@/components/error-text";
import { UserAvatar } from "@/components/user-avatar";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useSubmit } from "@/hooks/use-submit";
import { client, displayName, lastVisited, useApp, usePerms } from "../../session";
import { SETTINGS_PERMS } from "../ServerSidebar";
import { CreateChannelDialog } from "../dialogs/CreateChannelDialog";
import { InviteDialog } from "../dialogs/InviteDialog";
import { openSettings, type SettingsSection } from "../settings/settings-store";
import { openPanel, openProfile, setSearchQuery } from "../side-panel/panel";
import { openShortcutSheet } from "@/components/shortcut-sheet";
import { useVoice, voice } from "../../voice/voice";
import { emitToggleMembers } from "../chat-events";
import { closeCommands, findDM, toggleCommands, useCommands } from "./command-store";

const CHANNEL_ICONS: Record<string, AnimatedIcon> = { voice: Volume2, welcome: BookOpen };

const SETTINGS: { id: SettingsSection; label: string }[] = [
  { id: "profile", label: "My profile" },
  { id: "sessions", label: "Sessions" },
  { id: "notifications", label: "Notifications" },
  { id: "voice", label: "Voice & audio" },
  { id: "appearance", label: "Appearance" },
];

/** Ctrl/Cmd+K: jump to a channel or person, run an action, or hand a query to message search. */
export function CommandPalette() {
  const open = useCommands((s) => s.open);
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<"invite" | "create">();
  const { busy, error, run } = useSubmit();

  const channelIds = useApp(useShallow(sidebarChannelIds));
  const channels = useApp((s) => s.channels);
  const dmIds = useApp((s) => s.dmIds);
  const members = useApp((s) => s.server?.members);
  const sv = useApp((s) => s.server?.server);
  const me = useApp((s) => s.me);
  const perms = usePerms();
  const canInvite = useApp(canCreateInvites);
  const canSettings = !!me?.is_admin || SETTINGS_PERMS.some((p) => hasPerm(perms, p));
  const canCreate = hasPerm(perms, Perm.ManageChannels);
  const inCall = useVoice((v) => v.status !== "idle");
  const chatId = /^\/(?:channels|messages)\/([^/]+)/.exec(pathname)?.[1];
  const lastMessageId = useApp((s) => (chatId ? s.readStates[chatId]?.lastMessageId : undefined));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      e.stopPropagation();
      toggleCommands();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const people = useMemo(() => {
    // Members still behind the rules gate can't open DMs yet.
    const gated = (m: Member) => !!sv?.rules_gate && !m.accepted_rules_at && m.user.id !== sv.owner_id;
    return Object.values(members ?? {}).filter((m) => !gated(m) && m.user.id !== me?.id).map((m) => m.user)
      .sort((a, b) => displayName(a).localeCompare(displayName(b)));
  }, [members, me, sv]);

  const go = (to: string) => {
    closeCommands();
    nav(to);
  };
  const act = (fn: () => void) => {
    closeCommands();
    fn();
  };
  const message = (userId: string) => void run(async () => {
    const existing = me && findDM(dmIds, channels, me.id, userId);
    if (existing) return go(`/messages/${existing}`);
    const ch = await unwrap(client.api.POST("/api/dms", { body: { recipient_ids: [userId] } }));
    client.apply("CHANNEL_CREATE", ch);
    go(`/messages/${ch.id}`);
  });
  const search = () => {
    const q = query.trim();
    closeCommands();
    // Search results live in the side panel, which only channel and DM pages have.
    if (!/^\/(channels|messages)\/./.test(pathname)) {
      const last = lastVisited("channel");
      const to = last && channels[last] ? last : channelIds[0];
      if (to) nav(`/channels/${to}`);
    }
    setSearchQuery(q);
    openPanel({ kind: "search" });
  };

  const settings = SETTINGS.filter((s) => !(s.id === "sessions" && me?.guest_expires_at));

  return (
    <>
      <CommandDialog open={open} onOpenChange={(o) => !o && closeCommands()}
        title="Command palette" description="Jump to a channel or person, or run an action.">
        <CommandInput aria-label="Command palette" placeholder="Search channels, people and actions…" value={query} onValueChange={setQuery} />
        <CommandList className="max-h-[400px]">
          <CommandEmpty>No matches.</CommandEmpty>
          <CommandGroup heading="Channels">
            {channelIds.map((id) => {
              const ch = channels[id];
              if (!ch) return null;
              const Icon = CHANNEL_ICONS[ch.type] ?? Hash;
              return (
                <CommandItem key={id} value={`#${ch.name} ${id}`} onSelect={() => go(`/channels/${id}`)}>
                  <Icon />{ch.name}
                </CommandItem>
              );
            })}
          </CommandGroup>
          <CommandGroup heading="People">
            {people.map((u) => (
              <CommandItem key={u.id} value={`${displayName(u)} @${u.username} ${u.id}`} disabled={busy} onSelect={() => message(u.id)}>
                <UserAvatar user={u} size="sm" />{displayName(u)} <span className="text-muted-foreground">@{u.username}</span>
              </CommandItem>
            ))}
            {query.trim() && people.map((u) => (
              <CommandItem key={`profile-${u.id}`} value={`profile ${displayName(u)} @${u.username} ${u.id}`}
                onSelect={() => act(() => openProfile(u.id))}>
                <User />View profile: {displayName(u)}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Actions">
            {settings.map((s) => (
              <CommandItem key={s.id} value={`settings ${s.label}`} onSelect={() => act(() => openSettings(s.id))}>
                <Settings />Settings: {s.label}
              </CommandItem>
            ))}
            {chatId && lastMessageId && <CommandItem value="mark as read" onSelect={() => act(() => void client.ack(chatId, lastMessageId).catch(() => undefined))}><CheckCheck />Mark as read</CommandItem>}
            {inCall && <CommandItem value="leave voice" onSelect={() => act(() => void voice.leave())}><PhoneOff />Leave voice</CommandItem>}
            {chatId && <CommandItem value="toggle members" onSelect={() => act(emitToggleMembers)}><Users />Toggle members</CommandItem>}
            <CommandItem value="keyboard shortcuts" onSelect={() => act(openShortcutSheet)}><Keyboard />Keyboard shortcuts</CommandItem>
            {canSettings && <CommandItem value="server settings" onSelect={() => go("/server-settings")}><Settings />Server settings</CommandItem>}
            {canCreate && <CommandItem value="create channel" onSelect={() => act(() => setDialog("create"))}><Plus />Create channel</CommandItem>}
            {canInvite && <CommandItem value="invite people" onSelect={() => act(() => setDialog("invite"))}><UserPlus />Invite people</CommandItem>}
          </CommandGroup>
          {query.trim() && (
            <CommandGroup heading="Search" forceMount>
              <CommandItem forceMount value={`search messages ${query}`} onSelect={search}>
                <Search />Search messages for “{query.trim()}”
              </CommandItem>
            </CommandGroup>
          )}
        </CommandList>
        {error && <div className="border-t px-3 py-2"><ErrorText error={error} /></div>}
      </CommandDialog>
      {dialog === "invite" && <InviteDialog onClose={() => setDialog(undefined)} />}
      {dialog === "create" && <CreateChannelDialog onClose={() => setDialog(undefined)} />}
    </>
  );
}
