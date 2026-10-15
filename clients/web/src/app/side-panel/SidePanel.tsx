import { MessageSquare, X } from "@/components/icons";
import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { useLayoutTier } from "@/hooks/use-layout-tier";
import { useTitleBarClass, useTitleBarEdges } from "@/hooks/use-title-bar-edges";

/** The right-hand panel next to a channel (a thread, the threads list, search, a gallery item, a voice channel's chat).
 *  Wide windows dock it beside the chat; narrow and medium windows slide it over the chat (a modal sheet: focus moves in,
 *  Esc closes, focus returns). Phones keep the full-screen overlay. */
export function SidePanel({ title, label = title, closeLabel = `Close ${title.toLowerCase()}`, icon, subtitle, actions, onClose, children }: {
  title: string;
  /** The panel's accessible name (default: the title). */
  label?: string;
  /** The close button's accessible name (default: "Close <title>"). */
  closeLabel?: string;
  /** The header icon (default: a speech bubble). */
  icon?: ReactNode;
  subtitle?: string;
  /** Buttons in the header, before the close button. */
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const mobile = useIsMobile();
  const tier = useLayoutTier();
  const edges = useTitleBarEdges();
  const bandClass = useTitleBarClass("flex min-h-14 flex-none items-center gap-2 border-b pl-4 pr-2 max-md:pt-[env(safe-area-inset-top,0px)]");
  const heading = useRef<HTMLHeadingElement>(null);
  const docked = !mobile && tier === "wide";
  // Docked: move focus to the heading on open, so keyboard and screen reader users land in the panel.
  useEffect(() => {
    if (!docked) return;
    const a = document.activeElement;
    // Opening search from its box must leave typing in the box.
    if (a instanceof HTMLElement && (a.matches("input, textarea, select") || a.isContentEditable)) return;
    heading.current?.focus({ preventScroll: true });
  }, [docked]);

  const header = (
    <header ref={edges} data-titlebar-drag className={bandClass}>
      <span className="flex-none text-muted-foreground [&_svg]:size-4" aria-hidden>{icon ?? <MessageSquare />}</span>
      <div className="min-w-0 flex-1">
        <h2 ref={heading} tabIndex={-1} className="truncate text-body font-semibold outline-none">{title}</h2>
        {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {actions}
      <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={closeLabel} title="Close" onClick={onClose}>
        <X />
      </Button>
    </header>
  );

  if (!mobile && !docked) {
    return (
      <Sheet open onOpenChange={(o) => !o && onClose()}>
        <SheetContent side="right" aria-label={label} showCloseButton={false} className="w-[360px] gap-0 bg-card p-0 sm:max-w-[360px]">
          <SheetTitle className="sr-only">{label}</SheetTitle>
          <SheetDescription className="sr-only">{subtitle ?? title}</SheetDescription>
          {header}
          {children}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <aside aria-label={label}
      onKeyDown={(e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); onClose(); } }}
      className="flex min-h-0 w-[360px] max-w-full flex-none flex-col border-l bg-card max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-30 max-md:w-full max-md:border-l-0 max-md:pb-safe max-md:shadow-xl">
      {header}
      {children}
    </aside>
  );
}
