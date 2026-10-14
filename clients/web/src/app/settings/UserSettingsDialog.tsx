import { Settings } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useHistoryLayer, useLayerNavigate } from "@/hooks/use-history-layer";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { useApp } from "../../session";
import { NAV } from "../server-settings/ServerSettings";
import { GROUPS, visibleSections } from "./sections";
import { closeSettings, showSection, useSettings } from "./settings-store";

/** "Your settings": a modal with a section nav on the left, like server settings. */
export function UserSettingsDialog() {
  const open = useSettings((s) => s.open);
  const section = useSettings((s) => s.section);
  const isAdmin = useApp((s) => !!s.me?.is_admin);
  const isGuest = useApp((s) => !!s.me?.guest_expires_at);
  const nav = useLayerNavigate();
  const mobile = useIsMobile();
  useHistoryLayer("settings", open && mobile, closeSettings);
  const sections = visibleSections({ guest: isGuest, admin: isAdmin });
  const current = sections.find((s) => s.id === section) ?? sections[0];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeSettings()}>
      <DialogContent aria-describedby={undefined}
        className={cn("grid h-[85vh] max-h-[760px] grid-cols-[220px_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[1000px]",
          // Phones: full screen, the sections as a scrolling row of tabs above the page.
          "max-md:h-dvh max-md:max-h-none max-md:max-w-full max-md:grid-cols-1 max-md:grid-rows-[auto_minmax(0,1fr)] max-md:rounded-none max-md:border-0 max-md:pt-safe max-md:pb-safe")}>
        <DialogTitle className="sr-only">Your settings</DialogTitle>
        <nav aria-label="Settings sections" className={cn("flex min-h-0 flex-col overflow-y-auto overscroll-y-contain border-r bg-sidebar px-2 pt-1 pb-2",
          "max-md:flex-row max-md:gap-1 max-md:overflow-x-auto max-md:overflow-y-hidden max-md:border-r-0 max-md:border-b max-md:py-2 max-md:pr-12")}>
          {GROUPS.map((g) => (
            <div key={g} className="max-md:contents">
              <div className="px-2.5 pt-4 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase max-md:hidden">{g}</div>
              {sections.filter((s) => s.group === g).map((s) => {
                const Icon = s.icon;
                const active = s.id === current.id;
                return (
                  <button key={s.id} type="button" aria-current={active ? "page" : undefined} onClick={() => showSection(s.id)}
                    className={cn(NAV, "w-full hover:bg-accent hover:text-foreground max-md:w-auto max-md:flex-none max-md:whitespace-nowrap", active && "bg-accent text-foreground")}>
                    <Icon className="size-4 flex-none" aria-hidden />{s.label}
                  </button>
                );
              })}
            </div>
          ))}
          {isAdmin && (
            <button type="button" onClick={() => { closeSettings(); nav("/server-settings"); }}
              className={cn(NAV, "mt-auto w-full hover:bg-accent hover:text-foreground max-md:mt-0 max-md:w-auto max-md:flex-none max-md:whitespace-nowrap")}>
              <Settings className="size-4 flex-none" aria-hidden />Server settings
            </button>
          )}
        </nav>
        <div className="grid min-h-0 content-start gap-4 overflow-y-auto overscroll-y-contain p-6 max-md:p-3">
          <h2>{current.label}</h2>
          {current.body()}
        </div>
      </DialogContent>
    </Dialog>
  );
}
