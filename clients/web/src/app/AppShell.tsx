import { expireTyping, isGated } from "@datrope/core";
import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { usePalette } from "@/hooks/use-palette";
import { client, useApp } from "../session";
import { NotAMember } from "./NotAMember";
import { NotificationListener } from "./NotificationListener";
import { ServerSidebar } from "./ServerSidebar";
import { SoundboardListener } from "./voice/SoundboardPanel";

export function AppShell() {
  const connection = useApp((s) => s.connection);
  const notMember = useApp((s) => s.connection === "ready" && s.server === null);
  const gated = useApp(isGated);
  const welcomeId = useApp((s) => s.server?.channelIds.find((id) => s.channels[id]?.type === "welcome"));
  const { pathname } = useLocation();
  usePalette();
  useEffect(() => {
    const t = setInterval(() => client.store.setState((s) => expireTyping(s), true), 2000);
    return () => clearInterval(t);
  }, []);

  // A fresh READY resets the inbox; load it again after every (re)connect.
  useEffect(() => {
    if (connection === "ready") client.loadMentions().catch(() => undefined);
  }, [connection]);

  if (notMember) return <NotAMember />;
  // While the rules gate is on, the welcome channel is the only page.
  if (gated && welcomeId && pathname !== `/channels/${welcomeId}`) return <Navigate to={`/channels/${welcomeId}`} replace />;
  return (
    <div className="flex h-screen overflow-hidden">
      {/* Server settings bring their own nav in place of the sidebar. */}
      {!pathname.startsWith("/server-settings") && <ServerSidebar />}
      <Outlet />
      <SoundboardListener />
      <NotificationListener />
      {connection === "reconnecting" && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-foreground px-3.5 py-1.5 text-background" role="status">Reconnecting…</div>}
    </div>
  );
}
