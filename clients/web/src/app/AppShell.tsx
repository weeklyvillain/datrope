import { expireTyping, isGated } from "@datrope/core";
import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { usePalette } from "@/hooks/use-palette";
import { useTheme } from "@/hooks/use-theme";
import { client, useApp } from "../session";
import { GuestEnded } from "../pages/GuestEnded";
import { GuestBanner } from "./GuestBanner";
import { NotAMember } from "./NotAMember";
import { NotificationListener } from "./NotificationListener";
import { CommandPalette } from "./palette/CommandPalette";
import { ServerSidebar } from "./ServerSidebar";
import { ProfileDrawer } from "./people/ProfileDrawer";
import { UserSettingsDialog } from "./settings/UserSettingsDialog";
import { openSettings } from "./settings/settings-store";
import { SoundboardListener } from "./voice/SoundboardPanel";

export function AppShell() {
  const connection = useApp((s) => s.connection);
  const notMember = useApp((s) => s.connection === "ready" && s.server === null);
  const gated = useApp(isGated);
  const welcomeId = useApp((s) => s.server?.channelIds.find((id) => s.channels[id]?.type === "welcome"));
  const serverName = useApp((s) => s.server?.server.name);
  const isGuest = useApp((s) => !!s.me?.guest_expires_at);
  const { pathname } = useLocation();
  usePalette();
  useEffect(() => {
    document.title = serverName ? `Datrope - ${serverName}` : "Datrope";
  }, [serverName]);
  useTheme();
  useEffect(() => {
    const t = setInterval(() => client.store.setState((s) => expireTyping(s), true), 2000);
    return () => clearInterval(t);
  }, []);

  // Back from linking an account (see ConnectionsSettings): show how it went.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const provider = q.get("connection");
    if (!provider) return;
    const name = provider === "twitch" ? "Twitch" : "Spotify";
    const result = q.get("result");
    openSettings("connections", result === "ok" ? `${name} is connected.`
      : result === "cancelled" ? `Connecting ${name} was cancelled.`
      : result === "expired" ? `That ${name} sign-in expired. Try again.` : `${name} could not be connected. Try again.`);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  // A fresh READY resets the inbox; load it again after every (re)connect.
  useEffect(() => {
    if (connection === "ready") client.loadMentions().catch(() => undefined);
  }, [connection]);

  // A removed guest cannot rejoin with an invite, so NotAMember would mislead.
  if (notMember && isGuest) return <GuestEnded />;
  if (notMember) return <NotAMember />;
  // While the rules gate is on, the welcome channel is the only page.
  if (gated && welcomeId && pathname !== `/channels/${welcomeId}`) return <Navigate to={`/channels/${welcomeId}`} replace />;
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <GuestBanner />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Server settings bring their own nav in place of the sidebar. */}
        {!pathname.startsWith("/server-settings") && <ServerSidebar />}
        <Outlet />
        <SoundboardListener />
        <NotificationListener />
        <UserSettingsDialog />
        {!gated && <ProfileDrawer />}
        {!gated && <CommandPalette />}
        {connection === "reconnecting" && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-foreground px-3.5 py-1.5 text-background" role="status">Reconnecting…</div>}
      </div>
    </div>
  );
}
