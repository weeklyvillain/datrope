import { expireTyping, isGated } from "@datrope/core";
import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { usePalette } from "@/hooks/use-palette";
import { useTheme } from "@/hooks/use-theme";
import { useVisualViewport } from "@/hooks/use-visual-viewport";
import { desktop } from "../desktop";
import { client, useApp } from "../session";
import { GuestEnded } from "../pages/GuestEnded";
import { DesktopBridge } from "./DesktopBridge";
import { GuestBanner } from "./GuestBanner";
import { AudioEngine } from "./player/AudioEngine";
import { PlayerBar } from "./player/PlayerBar";
import { NotAMember } from "./NotAMember";
import { NotificationListener } from "./NotificationListener";
import { PushBridge } from "./PushBridge";
import { CommandPalette } from "./palette/CommandPalette";
import { ServerSidebar } from "./ServerSidebar";
import { MobileShell } from "./mobile/MobileShell";
import { useIsMobile } from "@/hooks/use-mobile";
import { ProfileDrawer } from "./people/ProfileDrawer";
import { stripLayer } from "@/lib/history-layers";
import { openPanel } from "./side-panel/panel";
import { paramToPanel } from "./side-panel/panel-param";
import { UserSettingsDialog } from "./settings/UserSettingsDialog";
import { openSettings } from "./settings/settings-store";
import { SoundboardListener } from "./voice/SoundboardPanel";

export function AppShell() {
  useVisualViewport();
  const connection = useApp((s) => s.connection);
  const notMember = useApp((s) => s.connection === "ready" && s.server === null);
  const gated = useApp(isGated);
  const welcomeId = useApp((s) => s.server?.channelIds.find((id) => s.channels[id]?.type === "welcome"));
  const serverName = useApp((s) => s.server?.server.name);
  const isGuest = useApp((s) => !!s.me?.guest_expires_at);
  const { pathname } = useLocation();
  usePalette();
  const mobile = useIsMobile();
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

  // A reload keeps the open side panel in `?panel=`: drop it from the URL, then reopen it as a layer so Back closes it.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const p = paramToPanel(q.get("panel"));
    if (q.has("panel")) {
      q.delete("panel");
      const s = q.toString();
      window.history.replaceState(stripLayer(window.history.state), "", window.location.pathname + (s ? `?${s}` : "") + window.location.hash);
    }
    if (p) openPanel(p);
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
    <div className="flex h-[calc(100dvh-var(--keyboard-inset,0px))] flex-col overflow-hidden has-[>[data-guest-banner]]:[--safe-top:0px]">
      <GuestBanner />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Phones: full-screen pages and a tab bar. Desktop: server settings bring their own nav in place of the sidebar. */}
        {mobile ? <MobileShell /> : (
          <>
            {!pathname.startsWith("/server-settings") && <ServerSidebar />}
            <Outlet />
          </>
        )}
        {/* The music player's audio, for both shells: the desktop bar and the phone player only show it. */}
        <AudioEngine />
        <SoundboardListener />
        <NotificationListener />
        <PushBridge />
        {desktop && <DesktopBridge />}
        <UserSettingsDialog />
        {!gated && <ProfileDrawer />}
        {!gated && <CommandPalette />}
        {/* Phones show it in MobileShell, clear of the tab bar. */}
        {!mobile && connection === "reconnecting" && <div className="fixed bottom-safe left-1/2 -translate-x-1/2 rounded-full bg-foreground px-3.5 py-1.5 text-background" role="status">Reconnecting…</div>}
      </div>
      {!gated && !mobile && <PlayerBar />}
    </div>
  );
}
