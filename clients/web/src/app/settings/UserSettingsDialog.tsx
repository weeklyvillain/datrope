import { Bell, Headphones, Link2, MonitorSmartphone, Palette, Settings, User, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useApp } from "../../session";
import { NAV } from "../server-settings/ServerSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { ConnectionsSettings } from "./ConnectionsSettings";
import { NotificationSettings } from "./NotificationSettings";
import { ProfileSettings } from "./ProfileSettings";
import { SessionsSettings } from "./SessionsSettings";
import { VoiceSettings } from "./VoiceSettings";
import { closeSettings, showSection, useSettings, type SettingsSection } from "./settings-store";

type Group = "Account" | "App";
const GROUPS: Group[] = ["Account", "App"];
const SECTIONS: { id: SettingsSection; label: string; group: Group; icon: LucideIcon; body: () => ReactNode }[] = [
  { id: "profile", label: "My profile", group: "Account", icon: User, body: () => <ProfileSettings /> },
  { id: "connections", label: "Connections", group: "Account", icon: Link2, body: () => <ConnectionsSettings /> },
  { id: "sessions", label: "Sessions", group: "Account", icon: MonitorSmartphone, body: () => <SessionsSettings /> },
  { id: "notifications", label: "Notifications", group: "App", icon: Bell, body: () => <NotificationSettings /> },
  { id: "voice", label: "Voice & audio", group: "App", icon: Headphones, body: () => <VoiceSettings /> },
  { id: "appearance", label: "Appearance", group: "App", icon: Palette, body: () => <AppearanceSettings /> },
];

/** "Your settings": a modal with a section nav on the left, like server settings. */
export function UserSettingsDialog() {
  const open = useSettings((s) => s.open);
  const section = useSettings((s) => s.section);
  const isAdmin = useApp((s) => !!s.me?.is_admin);
  const isGuest = useApp((s) => !!s.me?.guest_expires_at);
  const nav = useNavigate();
  // Guests have one session that ends with their access; there is nothing to manage.
  const sections = isGuest ? SECTIONS.filter((s) => s.id !== "sessions" && s.id !== "connections") : SECTIONS;
  const current = sections.find((s) => s.id === section) ?? sections[0];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeSettings()}>
      <DialogContent aria-describedby={undefined}
        className="grid h-[85vh] max-h-[760px] grid-cols-[220px_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[1000px]">
        <DialogTitle className="sr-only">Your settings</DialogTitle>
        <nav aria-label="Settings sections" className="flex min-h-0 flex-col overflow-y-auto border-r bg-sidebar px-2 pt-1 pb-2">
          {GROUPS.map((g) => (
            <div key={g}>
              <div className="px-2.5 pt-4 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g}</div>
              {sections.filter((s) => s.group === g).map((s) => {
                const Icon = s.icon;
                const active = s.id === current.id;
                return (
                  <button key={s.id} type="button" aria-current={active ? "page" : undefined} onClick={() => showSection(s.id)}
                    className={cn(NAV, "w-full hover:bg-accent hover:text-foreground", active && "bg-accent text-foreground")}>
                    <Icon className="size-4 flex-none" aria-hidden />{s.label}
                  </button>
                );
              })}
            </div>
          ))}
          {isAdmin && (
            <button type="button" onClick={() => { closeSettings(); nav("/server-settings"); }}
              className={cn(NAV, "mt-auto w-full hover:bg-accent hover:text-foreground")}>
              <Settings className="size-4 flex-none" aria-hidden />Server settings
            </button>
          )}
        </nav>
        <div className="grid min-h-0 content-start gap-4 overflow-y-auto p-6">
          <h2>{current.label}</h2>
          {current.body()}
        </div>
      </DialogContent>
    </Dialog>
  );
}
