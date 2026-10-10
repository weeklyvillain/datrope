import { Menu } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { isUnread, useApp } from "../session";
import { settingsStore } from "./settings/settings-store";

/** Whether the phone navigation drawer (the sidebar) is open. */
export const mobileNav = createStore<{ open: boolean }>(() => ({ open: false }));
export const openMobileNav = () => mobileNav.setState({ open: true });
const useMobileNav = () => useStore(mobileNav, (s) => s.open);

/** The sidebar as a drawer from the left, on phones. It closes when the page changes. */
export function MobileNavDrawer({ children }: { children: ReactNode }) {
  const open = useMobileNav();
  const { pathname } = useLocation();
  useEffect(() => mobileNav.setState({ open: false }), [pathname]);
  // Your settings open over the whole app, not over the drawer.
  useEffect(() => settingsStore.subscribe((s) => s.open && mobileNav.setState({ open: false })), []);
  return (
    <Sheet open={open} onOpenChange={(o) => mobileNav.setState({ open: o })}>
      <SheetContent side="left" showCloseButton={false} className="w-[85vw] max-w-80 gap-0 p-0 sm:max-w-80">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SheetDescription className="sr-only">Channels, direct messages and your profile</SheetDescription>
        {children}
      </SheetContent>
    </Sheet>
  );
}

/** The top bar's menu button on phones; a dot marks unread channels or messages elsewhere. */
export function MobileNavButton() {
  const unread = useApp((s) => Object.values(s.readStates).some(isUnread));
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Open navigation" className="relative -ml-1 flex-none md:hidden" onClick={openMobileNav}>
      <Menu />
      {unread && <span className="absolute top-1 right-1 size-2 rounded-full bg-foreground" aria-hidden />}
    </Button>
  );
}
