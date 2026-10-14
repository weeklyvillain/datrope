import { isGated } from "@datrope/core";
import { Settings, UserRound } from "lucide-react";
import { useEffect } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { SettingsLayout } from "@/components/settings-layout";
import { useIsMobile } from "@/hooks/use-mobile";
import { client, lastVisited, useApp } from "../../session";
import { GROUPS, visibleSections } from "./sections";
import { closeNotice } from "./settings-store";

/** /settings/:section on desktop: "Your settings" in the same layout as server settings. */
function UserSettingsPage() {
  const { section } = useParams();
  const nav = useNavigate();
  const isAdmin = useApp((s) => !!s.me?.is_admin);
  const isGuest = useApp((s) => !!s.me?.guest_expires_at);
  const sections = visibleSections({ guest: isGuest, admin: isAdmin });
  const current = sections.find((s) => s.id === section);
  // Leaving Connections (nav link, Back, Esc) drops its "connected" notice.
  useEffect(() => (section === "connections" ? closeNotice : undefined), [section]);
  if (!current) return <Navigate to={`/settings/${sections[0]!.id}`} replace />;
  const back = () => {
    closeNotice();
    const last = lastVisited("channel");
    nav(last && client.store.getState().server?.channelIds.includes(last) ? `/channels/${last}` : "/");
  };
  return (
    <SettingsLayout title="Your settings" icon={<UserRound className="size-5" aria-hidden />} navLabel="Settings sections" current={current.label} onBack={back}
      groups={[
        ...GROUPS.map((g) => ({ label: g, items: sections.filter((s) => s.group === g).map((s) => ({ id: s.id, label: s.label, icon: s.icon, to: `/settings/${s.id}` })) })),
        ...(isAdmin ? [{ label: "", items: [{ id: "server", label: "Server settings", icon: Settings, to: "/server-settings" }] }] : []),
      ]}>
      {current.body()}
    </SettingsLayout>
  );
}

/** /settings/:section?. Phones use /you, except while the rules gate blocks it: there this page is their only settings. */
export function UserSettingsRoute() {
  const { section } = useParams();
  const mobile = useIsMobile();
  const gated = useApp(isGated);
  if (mobile && !gated) return <Navigate to={`/you/${section ?? ""}`} replace />;
  return <UserSettingsPage />;
}
