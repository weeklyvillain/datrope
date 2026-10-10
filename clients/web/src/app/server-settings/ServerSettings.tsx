import { Perm, hasPerm, type State, type User } from "@datrope/core";
import {
  ArrowLeft, Ban, BookOpen, Database, Hash, Palette, Plug, Settings, Shield, Smile, Ticket, UserPlus, Users, Volume2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { ServerIcon } from "@/components/logo";
import { cn } from "@/lib/utils";
import { client, lastVisited, useApp, usePerms } from "@/session";
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
import { Button } from "@/components/ui/button";
import { Uploads } from "./Uploads";

type Group = "Server" | "People" | "Expressions" | "Instance";

/**
 * One nav entry. A page has `element`; `to` links elsewhere in the app; `soon` is a disabled
 * placeholder for a later milestone. Hidden unless `visible` says the user may use it.
 */
export interface SettingsSection {
  id: string;
  label: string;
  group: Group;
  icon: LucideIcon;
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
  { id: "emoji", label: "Emoji", group: "Expressions", icon: Smile, visible: can(Perm.ManageExpressions), element: <Emoji /> },
  { id: "soundboard", label: "Soundboard", group: "Expressions", icon: Volume2, visible: can(Perm.ManageExpressions), element: <Soundboard /> },
  { id: "sign-ups", label: "Sign-ups", group: "Instance", icon: UserPlus, visible: admin, element: <SignUps /> },
  { id: "uploads", label: "Uploads and voice", group: "Instance", icon: Database, visible: admin, element: <Uploads /> },
  { id: "integrations", label: "Integrations", group: "Instance", icon: Plug, visible: admin, element: <Integrations /> },
];

const GROUPS: Group[] = ["Server", "People", "Expressions", "Instance"];
export const NAV = "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-muted-foreground";

/** /server-settings/:section? — a full-height page with its own nav, in place of the main layout. */
export function ServerSettings() {
  const { section } = useParams();
  const perms = usePerms();
  const me = useApp((s) => s.me);
  const name = useApp((s) => s.server?.server.name);
  const links = useApp(useShallow((s) => sections.map((x) => x.to?.(s))));
  const nav = useNavigate();
  // Back to the last channel visited in this tab, if it still exists; else Home picks one.
  const close = () => {
    const last = lastVisited("channel");
    nav(last && client.store.getState().server?.channelIds.includes(last) ? `/channels/${last}` : "/");
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (document.querySelector('[role="dialog"],[role="menu"]')) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav]);

  if (!me) return null;
  const shown = sections.filter((s) => s.visible(perms, me));
  const pages = shown.filter((s) => s.element);
  const current = pages.find((s) => s.id === section);
  if (!current && pages.length > 0) return <Navigate to={`/server-settings/${pages[0].id}`} replace />;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 max-md:flex-col">
      <nav aria-label="Server settings" className="flex w-[260px] min-w-[240px] flex-none flex-col border-r bg-sidebar max-md:w-full max-md:min-w-0 max-md:border-r-0 max-md:border-b">
        <div className="flex h-14 flex-none items-center gap-2.5 border-b px-3.5 max-md:h-12 max-md:px-2">
          <Button variant="ghost" size="icon-sm" aria-label="Back to chat" className="md:hidden" onClick={close}><ArrowLeft /></Button>
          <ServerIcon size={26} />
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">Server settings</span>
            <span className="block truncate text-xs text-muted-foreground">{name}</span>
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-2 max-md:flex max-md:gap-1 max-md:overflow-x-auto max-md:overflow-y-hidden max-md:py-2">
          {GROUPS.map((g) => {
            const items = shown.filter((s) => s.group === g);
            if (items.length === 0) return null;
            return (
              <div key={g} className="max-md:contents">
                <div className="px-2.5 pt-4 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase max-md:hidden">{g}</div>
                {items.map((s) => {
                  const link = links[sections.indexOf(s)];
                  const Icon = s.icon;
                  const body = <><Icon className="size-4 flex-none" aria-hidden />{s.label}</>;
                  if (s.soon) {
                    return (
                      <span key={s.id} aria-disabled="true" title={s.soon} className={cn(NAV, "cursor-not-allowed opacity-50 max-md:hidden")}>
                        {body}<span className="ml-auto text-xs">Soon</span>
                      </span>
                    );
                  }
                  const to = s.to ? link : `/server-settings/${s.id}`;
                  if (!to) return null;
                  const active = s.id === current?.id;
                  return (
                    <Link key={s.id} to={to} state={s.to ? { edit: true } : undefined} aria-current={active ? "page" : undefined}
                      className={cn(NAV, "hover:bg-accent hover:text-foreground max-md:flex-none max-md:whitespace-nowrap", active && "bg-accent text-foreground")}>
                      {body}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="flex-none border-t p-2.5 max-md:hidden">
          <button type="button" onClick={close} className={cn(NAV, "w-full text-foreground hover:bg-accent")}>
            <ArrowLeft className="size-4 flex-none" aria-hidden />Back to chat
            <span className="ml-auto text-xs text-muted-foreground">Esc</span>
          </button>
        </div>
      </nav>
      <main aria-label={current?.label ?? "Server settings"} className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <header className="flex h-14 flex-none items-center gap-3 border-b bg-card pr-4 pl-6 max-md:hidden">
          <h2 className="min-w-0 flex-1 truncate font-semibold">{current?.label ?? "Server settings"}</h2>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid max-w-[860px] gap-7 px-6 pt-6 pb-12 max-md:px-3 max-md:pt-4">
            {current?.element ?? <p className="text-muted-foreground">There is nothing here you can change.</p>}
          </div>
        </div>
      </main>
    </div>
  );
}
