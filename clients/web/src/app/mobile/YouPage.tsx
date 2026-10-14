import { hasPerm, type PresenceStatus } from "@datrope/core";
import { Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { EmojiText } from "@/chat/EmojiText";
import { UserAvatar } from "@/components/user-avatar";
import { cn } from "@/lib/utils";
import { closeNotice } from "../settings/settings-store";
import { useNotifyPrefs } from "@/notify/prefs";
import { choosePresence, displayName, errorText, signOut, useApp, usePerms } from "../../session";
import { EditStatusDialog } from "../ProfileStrip";
import { SETTINGS_PERMS } from "../ServerSidebar";
import { GROUPS, visibleSections } from "../settings/sections";
import { ScreenHeader } from "./ScreenHeader";
import { ROW, SettingsList, type SettingsRow } from "./SettingsList";
import { BareButton } from "@/components/bare-button";

const DOT: Record<PresenceStatus, string> = { online: "online", idle: "idle", invisible: "offline" };
const PRESENCE: { value: PresenceStatus; label: string }[] = [
  { value: "online", label: "Online" }, { value: "idle", label: "Idle" }, { value: "invisible", label: "Invisible" },
];
const LEVEL = { all: "All messages", mentions: "Mentions", nothing: "Nothing" } as const;

/** /you and /you/:section: the You tab (profile, presence, settings list) and each settings section as a full screen. */
export function YouPage() {
  const { section } = useParams();
  const me = useApp((s) => s.me);
  // Leaving the Connections screen drops its "connected" notice (closeSettings never runs on phones).
  useEffect(() => (section === "connections" ? closeNotice : undefined), [section]);
  const sections = visibleSections({ guest: !!me?.guest_expires_at, admin: !!me?.is_admin });
  if (!me) return null;
  if (section) {
    const current = sections.find((s) => s.id === section);
    if (!current) return <Navigate to="/you" replace />;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ScreenHeader title={current.label} />
        <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto overscroll-y-contain px-4 py-4 pb-safe">{current.body()}</div>
      </div>
    );
  }
  return <YouHome sections={sections} />;
}

function YouHome({ sections }: { sections: ReturnType<typeof visibleSections> }) {
  const me = useApp((s) => s.me)!;
  const presence = useApp((s) => s.presence);
  const perms = usePerms();
  const level = useNotifyPrefs((p) => p.level);
  const [editing, setEditing] = useState(false);
  const canServer = me.is_admin || SETTINGS_PERMS.some((p) => hasPerm(perms, p));
  const rows = (group: string): SettingsRow[] => sections.filter((s) => s.group === group).map((s) => ({
    id: s.id, label: s.label, icon: s.icon, to: `/you/${s.id}`, value: s.id === "notifications" ? LEVEL[level] : undefined,
  }));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-12 flex-none items-center border-b bg-topbar px-4 pt-safe text-topbar-foreground">
        <h2 className="text-body font-semibold">You</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
        <div className="flex items-center gap-3 px-4 py-4">
          <UserAvatar user={me} size="lg" status={DOT[presence]} className="size-[52px]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold">{displayName(me)}</div>
            <BareButton className="block min-h-[44px] max-w-full truncate text-left text-sm text-muted-foreground" onClick={() => setEditing(true)}>
              {me.custom_status ? <EmojiText text={me.custom_status} /> : "Set a status"}
            </BareButton>
          </div>
        </div>
        <div role="radiogroup" aria-label="Presence" className="border-t">
          {PRESENCE.map((p) => (
            <BareButton key={p.value} role="radio" aria-checked={presence === p.value} onClick={() => choosePresence(p.value)}
              className={cn(ROW, "active:bg-accent")}>
              <span className={cn("size-2.5 flex-none rounded-full", presence === p.value ? "bg-primary" : "border border-muted-foreground")} aria-hidden />
              {p.label}
            </BareButton>
          ))}
        </div>
        {GROUPS.map((g) => (
          <div key={g}>
            <div className="px-4 pt-5 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g}</div>
            <SettingsList label={g} rows={rows(g)} />
          </div>
        ))}
        {canServer && (
          <div className="pt-5">
            <SettingsList label="Server" rows={[{ id: "server-settings", label: "Server settings", icon: Settings, to: "/server-settings" }]} />
          </div>
        )}
        <div className="pt-5 pb-4">
          <BareButton className={cn(ROW, "justify-center border-y font-medium text-destructive active:bg-accent")}
            onClick={() => signOut().catch((e: unknown) => window.alert(errorText(e)))}>
            Sign out
          </BareButton>
        </div>
      </div>
      {editing && <EditStatusDialog current={me.custom_status} onClose={() => setEditing(false)} />}
    </div>
  );
}
