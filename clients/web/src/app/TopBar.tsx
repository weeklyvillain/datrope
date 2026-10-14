import { MoreVertical } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ActionSheet, ActionSheetItem } from "@/components/action-sheet";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { InboxButton } from "./InboxButton";
import { BackButton } from "./mobile/ScreenHeader";
import { SearchBox } from "./search/SearchBox";

/** One row of a phone conversation's overflow menu. */
export type PhoneAction = { label: string; icon: ReactNode; onSelect: () => void; destructive?: boolean };

const header = "relative flex min-h-14 flex-none items-center gap-2 border-b bg-topbar px-4 pt-safe text-topbar-foreground max-md:pl-[max(0.5rem,env(safe-area-inset-left))] max-md:pr-[max(0.5rem,env(safe-area-inset-right))]";

/** A view's top bar: its title on the left, its own buttons, then the inbox and search (unless `tools` is off).
 *  With `phoneActions`, phones get Back, the title (`onTitleClick`), Search and a ⋮ menu instead of the inline `actions`. */
export function TopBar({ actions, phoneActions, onTitleClick, tools = true, children }: {
  actions?: ReactNode; phoneActions?: PhoneAction[]; onTitleClick?: () => void; tools?: boolean; children: ReactNode;
}) {
  const mobile = useIsMobile();
  const [menu, setMenu] = useState(false);
  if (mobile && phoneActions) {
    return (
      <header className={header}>
        <BackButton className="-ml-1 max-md:size-[44px]" />
        {onTitleClick ? (
          // The title's heading stays a heading: a button can't contain one, so it lies over the title instead.
          <div className="relative flex min-h-[44px] min-w-0 flex-1 items-center gap-2 [&>h2]:min-w-0 [&>h2]:shrink [&>h2]:truncate">
            {children}
            <button type="button" aria-label="Open channel info" onClick={onTitleClick}
              className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 [&>h2]:min-w-0 [&>h2]:shrink [&>h2]:truncate">{children}</div>
        )}
        <div className="flex flex-none items-center gap-1">
          {tools && <SearchBox />}
          <Button variant="ghost" size="icon-sm" aria-label="More actions" className="text-muted-foreground max-md:size-[44px]" onClick={() => setMenu(true)}>
            <MoreVertical />
          </Button>
        </div>
        <ActionSheet open={menu} onOpenChange={setMenu} title="More actions">
          {phoneActions.map((a) => (
            <ActionSheetItem key={a.label} icon={a.icon} destructive={a.destructive} onSelect={() => { setMenu(false); a.onSelect(); }}>
              {a.label}
            </ActionSheetItem>
          ))}
        </ActionSheet>
      </header>
    );
  }
  return (
    <header className={header}>
      <BackButton className="-ml-1 md:hidden" />
      <div className="flex min-w-0 flex-1 items-center gap-2 [&>h2]:min-w-0 [&>h2]:shrink [&>h2]:truncate">{children}</div>
      <div className="flex flex-none items-center gap-1">
        {actions}
        {tools && (
          <>
            <InboxButton />
            <SearchBox />
          </>
        )}
      </div>
    </header>
  );
}
