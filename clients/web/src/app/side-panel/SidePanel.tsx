import { MessageSquare, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** The right-hand panel next to a channel (a thread, the threads list, a voice channel's chat).
 *  Under 900 px wide it overlays the message list. */
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
  return (
    <aside aria-label={label}
      className="flex min-h-0 w-[360px] max-w-full flex-none flex-col border-l bg-card max-[900px]:fixed max-[900px]:inset-y-0 max-[900px]:right-0 max-[900px]:z-30 max-[900px]:shadow-xl max-md:w-full max-md:border-l-0 max-[900px]:pb-safe">
      <header className="flex min-h-14 flex-none items-center gap-2 border-b pl-4 pr-2 max-[900px]:pt-[env(safe-area-inset-top,0px)]">
        <span className="flex-none text-muted-foreground [&_svg]:size-4" aria-hidden>{icon ?? <MessageSquare />}</span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold">{title}</h2>
          {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {actions}
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={closeLabel} title="Close" onClick={onClose}>
          <X />
        </Button>
      </header>
      {children}
    </aside>
  );
}
