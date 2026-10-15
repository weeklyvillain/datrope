import { useEffect, useRef } from "react";
import { Copy, Menu, Minus, RefreshCw, Square, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { desktop } from "../desktop";
import { useChrome } from "./desktop-chrome";

const win = "h-14 w-11 rounded-none text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-inset";

/** Minimize, maximize and close, fixed at the window's top right while this page draws the title bar (not on macOS). */
export function WindowControls() {
  const c = useChrome((s) => s);
  const box = useRef<HTMLDivElement>(null);
  const shown = !!desktop && c.claimed;
  // Header bands at the window's right edge pad themselves by the controls' measured width (the Update button counts too).
  useEffect(() => {
    const root = document.documentElement;
    const e = box.current;
    if (!shown || !e) return;
    const set = () => root.style.setProperty("--titlebar-right", `${e.offsetWidth}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(e);
    return () => {
      ro.disconnect();
      root.style.setProperty("--titlebar-right", "0px");
    };
  }, [shown, c.updateReady, c.platform]);
  if (!shown) return null;
  return (
    <div ref={box} className="pointer-events-auto fixed top-0 right-0 z-[60] flex h-14 items-center">
      {c.updateReady && (
        <Button size="xs" className="mr-2" aria-label="Restart to update" title="Update ready — restart" onClick={() => desktop?.windowAction("update")}>
          <RefreshCw /> Update
        </Button>
      )}
      {c.platform !== "macos" && (
        <>
          <Button variant="ghost" size="icon" aria-label="Minimize" title="Minimize" className={win} onClick={() => desktop?.windowAction("minimize")}><Minus /></Button>
          <Button variant="ghost" size="icon" aria-label={c.maximized ? "Restore" : "Maximize"} title={c.maximized ? "Restore" : "Maximize"} className={win}
            onClick={() => desktop?.windowAction("toggle_maximize")}>
            {c.maximized ? <Copy className="size-3.5 -scale-x-100" /> : <Square className="size-3.5" />}
          </Button>
          <Button variant="ghost" size="icon" aria-label="Close" title="Close" className={cn(win, "hover:bg-destructive hover:text-destructive-foreground")}
            onClick={() => desktop?.windowAction("close")}><X /></Button>
        </>
      )}
    </div>
  );
}

/** Opens the desktop app's server drawer; shows the other servers' unread dot or mention count. */
export function ServersButton() {
  const claimed = useChrome((s) => s.claimed);
  const others = useChrome((s) => s.others);
  if (!desktop || !claimed) return null;
  const text = others.mentions > 0 ? `${others.mentions} mentions on other servers` : others.unread ? "Unread messages on other servers" : undefined;
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Servers" aria-describedby={text ? "servers-badge" : undefined}
      className="relative flex-none text-muted-foreground hover:text-foreground" onClick={() => desktop?.windowAction("servers")}>
      <Menu />
      {others.mentions > 0 ? (
        <span aria-hidden className="absolute -top-0.5 -right-1 min-w-4 rounded-full bg-destructive px-1 text-caption leading-4 font-semibold text-destructive-foreground">
          {others.mentions > 99 ? "99+" : others.mentions}
        </span>
      ) : others.unread ? <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-foreground" /> : null}
      {text && <span id="servers-badge" className="sr-only">{text}</span>}
    </Button>
  );
}
