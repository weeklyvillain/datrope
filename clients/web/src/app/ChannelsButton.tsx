import { PanelLeft } from "@/components/icons";
import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useHistoryLayer, useLayerNavigate } from "@/hooks/use-history-layer";
import { ServerSidebar } from "./ServerSidebar";

// The sheet lives in the shell, not in each view's top bar: switching the sidebar's Channels / Messages tab changes
// the view (and its top bar) but keeps the sheet open.
const sheet = createStore<{ open: boolean }>(() => ({ open: false }));
const setOpen = (open: boolean) => sheet.setState({ open });

/** Narrow desktop windows: the channel list lives in a left sheet behind this button. */
export function ChannelsButton() {
  const open = useStore(sheet, (s) => s.open);
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Channels" aria-expanded={open} className="-ml-1 text-muted-foreground" onClick={() => setOpen(true)}>
      <PanelLeft />
    </Button>
  );
}

/** The narrow tier's channel sheet. Back closes it; picking a channel or conversation closes it and replaces its
 *  history entry, so Back then goes to the previous page. */
export function ChannelsSheet() {
  const open = useStore(sheet, (s) => s.open);
  const navigate = useLayerNavigate();
  useHistoryLayer("channels", open, () => setOpen(false));
  useEffect(() => () => setOpen(false), []); // leaving the narrow tier
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="left" showCloseButton={false} className="w-60 gap-0 p-0 sm:max-w-60"
        onClickCapture={(e) => {
          const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
          if (!a) return;
          if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && !a.target && a.origin === window.location.origin) {
            e.preventDefault(); // the router link then leaves the navigation to us
            navigate(a.pathname + a.search + a.hash);
          }
          setOpen(false);
        }}>
        <SheetTitle className="sr-only">Channels</SheetTitle>
        <SheetDescription className="sr-only">Channels and direct messages</SheetDescription>
        <ServerSidebar className="h-full border-r-0" />
      </SheetContent>
    </Sheet>
  );
}
