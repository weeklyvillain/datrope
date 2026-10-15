import { expireTyping, isGated } from "@datrope/core";
import { useEffect, useRef } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useTheme } from "@/hooks/use-theme";
import { useShortcuts } from "@/hooks/use-shortcuts";
import { ShortcutSheet } from "@/components/shortcut-sheet";
import { useVisualViewport } from "@/hooks/use-visual-viewport";
import { desktop } from "../desktop";
import { client, useApp } from "../session";
import { GuestEnded } from "../pages/GuestEnded";
import { ChannelsSheet } from "./ChannelsButton";
import { DesktopBridge } from "./DesktopBridge";
import { WindowControls } from "./WindowControls";
import { GuestBanner } from "./GuestBanner";
import { AudioEngine } from "./player/AudioEngine";
import { PlayerBar } from "./player/PlayerBar";
import { NotAMember } from "./NotAMember";
import { NotificationListener } from "./NotificationListener";
import { PushBridge } from "./PushBridge";
import { CommandPalette } from "./palette/CommandPalette";
import { ServerSidebar } from "./ServerSidebar";
import { SkipLinks } from "@/components/skip-links";
import { MobileShell } from "./mobile/MobileShell";
import { useIsMobile } from "@/hooks/use-mobile";
import { useLayoutTier } from "@/hooks/use-layout-tier";
import { ProfileDrawer } from "./people/ProfileDrawer";
import { stripLayer } from "@/lib/history-layers";
import { openPanel } from "./side-panel/panel";
import { paramToPanel } from "./side-panel/panel-param";
import { useLayerNavigate } from "@/hooks/use-history-layer";
import { openSettings, setSettingsGated, setSettingsNavigate } from "./settings/settings-store";
import { SoundboardListener } from "./voice/SoundboardPanel";
import { UpdateBanner } from "@/components/update-banner";

export function AppShell() {
  useVisualViewport();
  const connection = useApp((s) => s.connection);
  const notMember = useApp((s) => s.connection === "ready" && s.server === null);
  const gated = useApp(isGated);
  const welcomeId = useApp((s) => s.server?.channelIds.find((id) => s.channels[id]?.type === "welcome"));
  const serverName = useApp((s) => s.server?.server.name);
  const isGuest = useApp((s) => !!s.me?.guest_expires_at);
  const { pathname } = useLocation();
  const layerNavigate = useLayerNavigate();
  const navRef = useRef(layerNavigate);
  navRef.current = layerNavigate;
  const mobile = useIsMobile();
  const tier = useLayoutTier();
  useShortcuts(!mobile);
  useEffect(() => {
    document.title = serverName ? `Datrope - ${serverName}` : "Datrope";
  }, [serverName]);
  useTheme();
  // Desktop opens "Your settings" as a page. Phones register their own navigate (MobileShell), except while the rules gate
  // blocks /you: then /settings is their only settings page.
  useEffect(() => {
    if (mobile && !gated) return;
    setSettingsGated(gated);
    // Callers may sit inside a history layer (profile drawer, palette): the layer-aware navigate replaces its entry.
    setSettingsNavigate((p) => navRef.current(p));
    return () => { setSettingsNavigate(null); setSettingsGated(false); };
  }, [mobile, gated]);
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
  if (gated && welcomeId && pathname !== `/channels/${welcomeId}` && !pathname.startsWith("/settings")) return <Navigate to={`/channels/${welcomeId}`} replace />;
  return (
    <div className="flex h-[calc(100dvh-var(--keyboard-inset,0px))] flex-col overflow-hidden has-[>[data-guest-banner]]:[--safe-top:0px]">
      {!mobile && <SkipLinks />}
      <GuestBanner />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Phones: full-screen pages and a tab bar. Desktop: server settings bring their own nav in place of the sidebar. */}
        {mobile ? <MobileShell /> : (
          <>
            {!pathname.startsWith("/server-settings") && !pathname.startsWith("/settings") && tier !== "narrow" && <ServerSidebar />}
            {tier === "narrow" && <ChannelsSheet />}
            <Outlet />
          </>
        )}
        {/* The music player's audio, for both shells: the desktop bar and the phone player only show it. */}
        <AudioEngine />
        <SoundboardListener />
        <NotificationListener />
        <PushBridge />
        {desktop && <DesktopBridge />}
        {desktop && <WindowControls />}
        {!gated && <ProfileDrawer />}
        {!gated && <CommandPalette />}
        {!mobile && <ShortcutSheet />}
        {/* Phones show it in MobileShell, clear of the tab bar. */}
        {!mobile && connection === "reconnecting" && <div className="fixed bottom-safe left-1/2 -translate-x-1/2 rounded-full bg-foreground px-3.5 py-1.5 text-background" role="status">Reconnecting…</div>}
        {/* Under the header: it stays until dismissed, and the composer is at the bottom. */}
        {!mobile && connection !== "reconnecting" && <UpdateBanner className="top-14" />}
      </div>
      {!gated && !mobile && <PlayerBar />}
    </div>
  );
}
