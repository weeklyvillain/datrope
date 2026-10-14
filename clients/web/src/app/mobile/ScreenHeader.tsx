import { isGated } from "@datrope/core";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useLayerNavigate } from "@/hooks/use-history-layer";
import { cn } from "@/lib/utils";
import { useApp } from "../../session";
import { tabFor, tabPath } from "./tabs";

/** A pushed screen's back arrow: Back through history, or to the tab's root when the app opened on this page. None while gated. */
export function BackButton({ className }: { className?: string }) {
  const navigate = useNavigate();
  const layerNavigate = useLayerNavigate();
  const { pathname } = useLocation();
  // Gated members have one page (welcome); Back could only lead off the app, e.g. to the invite page.
  const gated = useApp(isGated);
  if (gated) return null;
  const back = () => {
    if ((window.history.state?.idx ?? 0) > 0) navigate(-1);
    // Opened straight on this page (a link, a notification): the tab root replaces it, so Back does not return here.
    else layerNavigate(tabPath[tabFor(pathname)], { replace: true });
  };
  return (
    <Button variant="ghost" size="icon" aria-label="Back" className={cn("flex-none", className)} onClick={back}>
      <ArrowLeft />
    </Button>
  );
}

/** A phone screen's top bar: back arrow, title, actions. */
export function ScreenHeader({ title, back = true, actions }: { title: ReactNode; back?: boolean; actions?: ReactNode }) {
  return (
    <header className="flex min-h-[48px] flex-none items-center gap-1 border-b bg-topbar pt-safe pr-[max(0.5rem,env(safe-area-inset-right))] pl-[max(0.25rem,env(safe-area-inset-left))] text-topbar-foreground">
      {back ? <BackButton /> : <span className="w-2" />}
      <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{title}</h2>
      {actions && <div className="flex flex-none items-center gap-1">{actions}</div>}
    </header>
  );
}
