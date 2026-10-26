import { Perm, hasPerm, myChannelPerms, type Channel } from "@datrope/core";
import { Bell, Rss, Settings, Shield, Webhook, type AnimatedIcon } from "@/components/icons";
import { type ReactNode } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { SettingsLayout } from "@/components/settings-layout";
import { useIsMobile } from "@/hooks/use-mobile";
import { useApp } from "@/session";
import { channelIcon } from "../channel-types";
import { AlertsTab } from "../dialogs/AlertsTab";
import { WebhooksTab } from "../dialogs/WebhooksTab";
import { ScreenHeader } from "../mobile/ScreenHeader";
import { SettingsList } from "../mobile/SettingsList";
import { General } from "./General";
import { Notifications } from "./Notifications";
import { Permissions } from "./Permissions";

type Group = "Channel" | "Integrations" | "You";

interface Section {
  id: string;
  label: string;
  group: Group;
  icon: AnimatedIcon;
  visible: (ch: Channel, perms: number) => boolean;
  element: (ch: Channel) => ReactNode;
}

const manage = (_: Channel, perms: number) => hasPerm(perms, Perm.ManageChannels);

const sections: Section[] = [
  { id: "general", label: "General", group: "Channel", icon: Settings, visible: manage, element: (ch) => <General key={ch.id} ch={ch} /> },
  { id: "permissions", label: "Permissions", group: "Channel", icon: Shield, visible: manage, element: (ch) => <Permissions key={ch.id} ch={ch} /> },
  {
    id: "webhooks", label: "Webhooks", group: "Integrations", icon: Webhook,
    visible: (ch, perms) => ch.type === "webhook" && hasPerm(perms, Perm.ManageWebhooks), element: (ch) => <WebhooksTab channelId={ch.id} />,
  },
  {
    id: "alerts", label: "Alerts", group: "Integrations", icon: Rss,
    visible: (ch, perms) => ["text", "announcement"].includes(ch.type) && hasPerm(perms, Perm.ManageChannels), element: (ch) => <AlertsTab channelId={ch.id} />,
  },
  { id: "notifications", label: "Notifications", group: "You", icon: Bell, visible: (ch) => ch.type !== "welcome", element: (ch) => <Notifications channelId={ch.id} /> },
];

const GROUPS: Group[] = ["Channel", "Integrations", "You"];

/** /channel-settings/:channelId/:section? — a channel's settings as a full-height page, like server settings. Everyone gets Notifications. */
export function ChannelSettings() {
  const { channelId = "", section } = useParams();
  const ch = useApp((s) => s.channels[channelId]);
  const perms = useApp((s) => myChannelPerms(s, channelId));
  const nav = useNavigate();
  const mobile = useIsMobile();
  const ready = useApp((s) => !!s.me);
  if (!ready) return null;
  if (!ch || ch.type === "dm" || ch.type === "thread") return <Navigate to="/" replace />;

  const shown = sections.filter((s) => s.visible(ch, perms));
  const current = shown.find((s) => s.id === section);
  const base = `/channel-settings/${ch.id}`;
  const close = () => nav(`/channels/${ch.id}`);
  const Icon = channelIcon(ch.type);
  if (mobile) {
    if (section && !current) return <Navigate to={base} replace />;
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ScreenHeader title={current?.label ?? `#${ch.name}`} />
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain pb-safe">
          {current ? <div className="grid gap-7 px-4 pt-4 pb-12">{current.element(ch)}</div> : GROUPS.map((g) => {
            const rows = shown.filter((s) => s.group === g).map((s) => ({ id: s.id, label: s.label, icon: s.icon, to: `${base}/${s.id}` }));
            if (rows.length === 0) return null;
            return (
              <div key={g}>
                <div className="px-4 pt-5 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g}</div>
                <SettingsList label={g} rows={rows} />
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  if (!current) return shown.length > 0 ? <Navigate to={`${base}/${shown[0].id}`} replace /> : <Navigate to={`/channels/${ch.id}`} replace />;

  return (
    <SettingsLayout title={`#${ch.name}`} subtitle="Channel settings" icon={<Icon className="size-5 flex-none text-muted-foreground" aria-hidden />}
      navLabel="Channel settings" current={current.label} onBack={close}
      groups={GROUPS.map((g) => ({
        label: g,
        items: shown.filter((s) => s.group === g).map((s) => ({ id: s.id, label: s.label, icon: s.icon, to: `${base}/${s.id}` })),
      }))}>
      {current.element(ch)}
    </SettingsLayout>
  );
}
