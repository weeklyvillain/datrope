import { ArrowLeft, type AnimatedIcon } from "@/components/icons";
import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ServersButton } from "@/app/WindowControls";
import { Button } from "@/components/ui/button";
import { useTitleBarClass, useTitleBarEdges } from "@/hooks/use-title-bar-edges";
import { cn } from "@/lib/utils";

export const NAV = "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-muted-foreground";

export interface SettingsItem {
  id: string;
  label: string;
  icon: AnimatedIcon;
  /** A link target; without it (and without `soon`) the item is a button that calls `onSelect`. */
  to?: string;
  onSelect?: () => void;
  badge?: ReactNode;
  /** A disabled placeholder for a later milestone; the text is its tooltip. */
  soon?: string;
  state?: unknown;
}
export interface SettingsGroup { label: string; items: SettingsItem[] }

/** Esc goes back, except in fields and while a dialog or menu is open (those close first). */
function useEscape(onBack: () => void) {
  const back = useRef(onBack);
  back.current = onBack;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (document.querySelector('[role="dialog"],[role="menu"]')) return;
      back.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** A full-height settings page: a nav of grouped sections beside a scrolling content column. Shared by server and user settings. */
export function SettingsLayout({ title, subtitle, icon, navLabel, groups, current, onBack, children }: {
  title: string;
  subtitle?: string;
  icon: ReactNode;
  navLabel: string;
  groups: SettingsGroup[];
  /** The label of the open section (also the page heading). */
  current?: string;
  onBack: () => void;
  children: ReactNode;
}) {
  useEscape(onBack);
  const navEdges = useTitleBarEdges();
  const navBand = useTitleBarClass("flex min-h-14 flex-none items-center gap-2.5 border-b px-3.5 max-md:min-h-12 max-md:px-2 max-md:pt-safe");
  const mainEdges = useTitleBarEdges();
  const mainBand = useTitleBarClass("flex h-14 flex-none items-center gap-3 border-b bg-card pr-4 pl-6 max-md:hidden");
  return (
    <div className="flex min-h-0 min-w-0 flex-1 max-md:flex-col">
      <nav aria-label={navLabel} className="flex w-[260px] min-w-[240px] flex-none flex-col border-r bg-sidebar max-md:w-full max-md:min-w-0 max-md:border-r-0 max-md:border-b">
        <div ref={navEdges} data-titlebar-drag className={navBand}>
          <ServersButton />
          <Button variant="ghost" size="icon-sm" aria-label="Back to chat" className="md:hidden" onClick={onBack}><ArrowLeft /></Button>
          {icon}
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">{title}</span>
            {subtitle && <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-2 pt-1 pb-2 max-md:flex max-md:gap-1 max-md:overflow-x-auto max-md:overflow-y-hidden max-md:py-2">
          {groups.map((g) => {
            if (g.items.length === 0) return null;
            return (
              <div key={g.label || g.items[0].id} className="max-md:contents">
                {g.label && <div className="px-2.5 pt-4 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase max-md:hidden">{g.label}</div>}
                {g.items.map((s) => {
                  const Icon = s.icon;
                  const body = <><Icon className="size-4 flex-none" aria-hidden />{s.label}</>;
                  if (s.soon) {
                    return (
                      <span key={s.id} aria-disabled="true" title={s.soon} className={cn(NAV, "cursor-not-allowed opacity-50 max-md:hidden")}>
                        {body}<span className="ml-auto text-xs">Soon</span>
                      </span>
                    );
                  }
                  const active = s.label === current;
                  const cls = cn(NAV, "hover:bg-accent hover:text-foreground max-md:flex-none max-md:whitespace-nowrap", active && "bg-accent text-foreground");
                  if (!s.to) {
                    return <button key={s.id} type="button" onClick={s.onSelect} aria-current={active ? "page" : undefined} className={cn(cls, "w-full max-md:w-auto")}>{body}{s.badge}</button>;
                  }
                  return (
                    <Link key={s.id} to={s.to} state={s.state} aria-current={active ? "page" : undefined} className={cls}>
                      {body}{s.badge}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="flex-none border-t p-2.5 max-md:hidden">
          <Button variant="ghost" className={cn(NAV, "w-full justify-start text-foreground")} onClick={onBack}>
            <ArrowLeft className="size-4 flex-none" aria-hidden />Back to chat
            <span className="ml-auto text-xs text-muted-foreground">Esc</span>
          </Button>
        </div>
      </nav>
      <main aria-label={current ?? title} className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <header ref={mainEdges} data-titlebar-drag className={mainBand}>
          <h1 className="min-w-0 flex-1 truncate font-semibold">{current ?? title}</h1>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
          <div className="grid max-w-[860px] gap-7 px-6 pt-6 pb-12 max-md:px-3 max-md:pt-4">{children}</div>
        </div>
      </main>
    </div>
  );
}
