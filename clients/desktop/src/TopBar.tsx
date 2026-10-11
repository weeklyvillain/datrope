import { Copy, Menu, Minus, RefreshCw, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { mentionLabel, otherServersBadge, serverInitials } from "./order";
import { closeWindow, minimizeWindow, restartToUpdate, toggleMaximizeWindow, type RailState } from "./rail-api";

const windowButton = "h-8 w-11 rounded-none text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-inset";

/** The custom title bar: Servers button and current server on the left, a drag region, window buttons on the right. */
export function TopBar({ state, drawerOpen, onToggleDrawer }: {
  state: RailState;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
}) {
  const current = state.servers.find((s) => s.id === state.selected);
  const badge = otherServersBadge(state.servers, state.selected);
  const badgeText = badge.mentions > 0
    ? `${badge.mentions} mentions on other servers`
    : badge.unread ? "Unread messages on other servers" : undefined;
  const mac = state.platform === "macos";

  return (
    // "deep": the whole bar drags the window (double-click maximizes) except its buttons.
    <header data-tauri-drag-region="deep"
      className={cn("flex h-8 shrink-0 items-center gap-2 bg-sidebar text-sidebar-foreground", mac ? "pl-[72px]" : "pl-1")}>
      {state.servers.length > 0 && (
        <Button variant="ghost" size="icon-sm" aria-label="Servers" title="Servers" aria-expanded={drawerOpen}
          aria-describedby={badgeText ? "servers-badge" : undefined}
          onClick={onToggleDrawer}
          className={cn("relative size-7 text-muted-foreground hover:text-foreground", drawerOpen && "bg-accent text-foreground")}>
          <Menu className="size-4" />
          {badge.mentions > 0 ? (
            <span aria-hidden className="absolute -top-0.5 -right-1 min-w-4 rounded-full bg-destructive px-1 text-[10px] leading-4 font-semibold text-destructive-foreground">
              {mentionLabel(badge.mentions)}
            </span>
          ) : badge.unread ? (
            <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-foreground" />
          ) : null}
        </Button>
      )}
      {badgeText && <span id="servers-badge" className="sr-only">{badgeText}</span>}

      {current && (
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-md bg-card text-[10px] font-semibold text-foreground">
            {current.icon ? <img src={current.icon} alt="" className="size-full object-cover" /> : serverInitials(current.name)}
          </span>
          <span className="truncate text-sm text-foreground">{current.name}</span>
        </div>
      )}

      <div className="h-full grow" />

      {state.updateReady && (
        <Button size="xs" aria-label="Restart to update" title="Update ready — restart" onClick={() => void restartToUpdate()}>
          <RefreshCw /> Update
        </Button>
      )}

      {!mac && (
        <div className="flex h-full">
          <Button variant="ghost" size="icon" aria-label="Minimize" title="Minimize" className={windowButton}
            onClick={() => void minimizeWindow()}>
            <Minus className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" aria-label={state.maximized ? "Restore" : "Maximize"}
            title={state.maximized ? "Restore" : "Maximize"} className={windowButton}
            onClick={() => void toggleMaximizeWindow()}>
            {state.maximized ? <Copy className="size-3.5 -scale-x-100" /> : <Square className="size-3.5" />}
          </Button>
          <Button variant="ghost" size="icon" aria-label="Close" title="Close"
            className={cn(windowButton, "hover:bg-destructive hover:text-destructive-foreground")}
            onClick={() => void closeWindow()}>
            <X className="size-4" />
          </Button>
        </div>
      )}
    </header>
  );
}
