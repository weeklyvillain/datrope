import { isGated } from "@datrope/core";
import { useEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { UpdateBanner } from "@/components/update-banner";
import { useLayerNavigate } from "@/hooks/use-history-layer";
import { cn } from "@/lib/utils";
import { useApp } from "../../session";
import { setSettingsNavigate } from "../settings/settings-store";
import { SidebarFooter } from "../SidebarFooter";
import { useRememberVisits } from "../ServerSidebar";
import { MiniBars } from "./MiniBars";
import { PlayerScreen } from "./PlayerScreen";
import { TabBar } from "./TabBar";
import { isTabRoot } from "./tabs";

/** The phone layout: the page full-screen, mini bars, and the tab bar on tab roots.
 *  Gated members (rules gate) get the profile strip instead, their only way to settings and Sign out. */
export function MobileShell() {
  const { pathname } = useLocation();
  const root = isTabRoot(pathname);
  const gated = useApp(isGated);
  const reconnecting = useApp((s) => s.connection === "reconnecting");
  useRememberVisits();
  // Settings open as a page on phones, except while gated (the gate blocks /you, so the dialog stays).
  // Callers may sit inside a history layer (profile drawer, palette): the layer-aware navigate replaces its entry.
  const layerNavigate = useLayerNavigate();
  const navRef = useRef(layerNavigate);
  navRef.current = layerNavigate;
  useEffect(() => {
    setSettingsNavigate(gated ? null : (p) => navRef.current(p));
    return () => setSettingsNavigate(null);
  }, [gated]);
  // Clear of the tab bar (or the gated footer) when there is one.
  const pillBottom = gated || root ? "bottom-[calc(60px+1rem+env(safe-area-inset-bottom,0px))]" : "bottom-safe";
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 overflow-hidden"><Outlet /></div>
      <MiniBars compact={!root} />
      <PlayerScreen />
      {gated ? <div className="flex-none bg-sidebar pb-safe"><SidebarFooter /></div> : root && <TabBar />}
      {reconnecting ? (
        <div role="status" className={cn("fixed left-1/2 -translate-x-1/2 rounded-full bg-foreground px-3.5 py-1.5 text-background", pillBottom)}>
          Reconnecting…
        </div>
      ) : <UpdateBanner className={gated || root ? pillBottom : "top-[calc(var(--safe-top,env(safe-area-inset-top,0px))+0.5rem)]"} />}
    </div>
  );
}
