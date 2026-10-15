import { Perm, hasPerm, type State, type User } from "@datrope/core";
import {
  Activity, Ban, BookOpen, Database, Hash, Moon, Palette, Plug, RefreshCw, ScrollText, Settings, Shield, Smile, Ticket, UserPlus, Users, Volume2,
  type AnimatedIcon,
} from "@/components/icons";
import { type ReactNode } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { ServerIcon } from "@/components/logo";
import { useIsMobile } from "@/hooks/use-mobile";
import { ScreenHeader } from "../mobile/ScreenHeader";
import { SettingsList } from "../mobile/SettingsList";
import { client, lastVisited, useApp, usePerms } from "@/session";
import { AuditLog } from "./AuditLog";
import { Bans } from "./Bans";
import { Emoji } from "./Emoji";
import { Integrations } from "./Integrations";
import { Invites } from "./Invites";
import { Look } from "./Look";
import { Members } from "./Members";
import { Overview } from "./Overview";
import { Roles } from "./Roles";
import { SignUps } from "./SignUps";
import { Soundboard } from "./Soundboard";
import { System } from "./System";
import { Badge } from "@/components/ui/badge";
import { SettingsLayout } from "@/components/settings-layout";
import { VoiceAFK } from "./VoiceAFK";
import { Updates } from "./Updates";
import { Uploads } from "./Uploads";
import { useUpdateCount } from "./use-update-count";

type Group = "Server" | "People" | "Expressions" | "Instance";

/**
 * One nav entry. A page has `element`; `to` links elsewhere in the app; `soon` is a disabled
 * placeholder for a later milestone. Hidden unless `visible` says the user may use it.
 */
export interface SettingsSection {
  id: string;
  label: string;
  group: Group;
  icon: AnimatedIcon;
  visible: (perms: number, me: User) => boolean;
  element?: ReactNode;
  to?: (s: State) => string | undefined;
  soon?: string;
}

const can = (...flags: number[]) => (perms: number) => flags.some((f) => hasPerm(perms, f));
const admin = (_: number, me: User) => me.is_admin;

export const sections: SettingsSection[] = [
  { id: "overview", label: "Overview", group: "Server", icon: Settings, visible: can(Perm.ManageServer), element: <Overview /> },
  { id: "look", label: "Look", group: "Server", icon: Palette, visible: can(Perm.ManageServer), element: <Look /> },
  { id: "voice", label: "Voice", group: "Server", icon: Moon, visible: can(Perm.ManageServer), element: <VoiceAFK /> },
  {
    id: "welcome", label: "Welcome page", group: "Server", icon: BookOpen, visible: can(Perm.ManageServer),
    to: (s) => {
      const id = s.server?.channelIds.find((c) => s.channels[c]?.type === "welcome");
      return id && `/channels/${id}`;
    },
  },
  { id: "channels", label: "Channels", group: "Server", icon: Hash, visible: can(Perm.ManageChannels), soon: "Coming in a later update" },
  { id: "members", label: "Members", group: "People", icon: Users, visible: can(Perm.Kick, Perm.Ban, Perm.ManageRoles), element: <Members /> },
  { id: "roles", label: "Roles", group: "People", icon: Shield, visible: can(Perm.ManageRoles), element: <Roles /> },
  { id: "invites", label: "Invites", group: "People", icon: Ticket, visible: can(Perm.ManageServer, Perm.CreateInvite), element: <Invites /> },
  { id: "bans", label: "Bans", group: "People", icon: Ban, visible: can(Perm.Ban), element: <Bans /> },
  { id: "audit-log", label: "Audit log", group: "People", icon: ScrollText, visible: can(Perm.ViewAuditLog), element: <AuditLog /> },
  { id: "emoji", label: "Emoji", group: "Expressions", icon: Smile, visible: can(Perm.ManageExpressions), element: <Emoji /> },
  { id: "soundboard", label: "Soundboard", group: "Expressions", icon: Volume2, visible: can(Perm.ManageExpressions), element: <Soundboard /> },
  { id: "sign-ups", label: "Sign-ups", group: "Instance", icon: UserPlus, visible: admin, element: <SignUps /> },
  { id: "uploads", label: "Uploads and voice", group: "Instance", icon: Database, visible: admin, element: <Uploads /> },
  { id: "integrations", label: "Integrations", group: "Instance", icon: Plug, visible: admin, element: <Integrations /> },
  { id: "system", label: "System", group: "Instance", icon: Activity, visible: admin, element: <System /> },
  { id: "updates", label: "Updates", group: "Instance", icon: RefreshCw, visible: admin, element: <Updates /> },
];

const GROUPS: Group[] = ["Server", "People", "Expressions", "Instance"];

/** /server-settings/:section? — a full-height page with its own nav, in place of the main layout. */
export function ServerSettings() {
  const { section } = useParams();
  const perms = usePerms();
  const me = useApp((s) => s.me);
  const updateCount = useUpdateCount(!!me?.is_admin);
  const name = useApp((s) => s.server?.server.name);
  const links = useApp(useShallow((s) => sections.map((x) => x.to?.(s))));
  const nav = useNavigate();
  const mobile = useIsMobile();
  // Back to the last channel visited in this tab, if it still exists; else Home picks one.
  const close = () => {
    const last = lastVisited("channel");
    nav(last && client.store.getState().server?.channelIds.includes(last) ? `/channels/${last}` : "/");
  };

  if (!me) return null;
  const shown = sections.filter((s) => s.visible(perms, me));
  const pages = shown.filter((s) => s.element);
  const current = pages.find((s) => s.id === section);
  if (mobile) {
    if (section && !current) return <Navigate to="/server-settings" replace />;
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ScreenHeader title={current?.label ?? "Server settings"} />
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain pb-safe">
          {current ? <div className="grid gap-7 px-4 pt-4 pb-12">{current.element}</div> : (
            <>
              {GROUPS.map((g) => {
                const rows = shown.filter((s) => s.group === g).flatMap((s) => {
                  const to = s.to ? links[sections.indexOf(s)] : `/server-settings/${s.id}`;
                  if (!s.soon && !to) return [];
                  return [{ id: s.id, label: s.label, icon: s.icon, to, soon: s.soon, state: s.to ? { edit: true } : undefined,
                    value: s.id === "updates" && updateCount > 0 ? `${updateCount} available` : undefined }];
                });
                if (rows.length === 0) return null;
                return (
                  <div key={g}>
                    <div className="px-4 pt-5 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g}</div>
                    <SettingsList label={g} rows={rows} />
                  </div>
                );
              })}
              {pages.length === 0 && <p className="px-4 pt-4 text-muted-foreground">There is nothing here you can change.</p>}
            </>
          )}
        </div>
      </div>
    );
  }
  if (!current && pages.length > 0) return <Navigate to={`/server-settings/${pages[0].id}`} replace />;

  return (
    <SettingsLayout title="Server settings" subtitle={name} icon={<ServerIcon size={26} />} navLabel="Server settings" current={current?.label} onBack={close}
      groups={GROUPS.map((g) => ({
        label: g,
        items: shown.filter((s) => s.group === g).map((s) => ({
          id: s.id, label: s.label, icon: s.icon, soon: s.soon,
          to: s.to ? links[sections.indexOf(s)] : `/server-settings/${s.id}`,
          state: s.to ? { edit: true } : undefined,
          badge: s.id === "updates" && updateCount > 0 ? <Badge className="ml-auto">{updateCount}<span className="sr-only"> updates available</span></Badge> : undefined,
        })).filter((i) => i.soon || i.to),
      }))}>
      {current?.element ?? <p className="text-muted-foreground">There is nothing here you can change.</p>}
    </SettingsLayout>
  );
}
