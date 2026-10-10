import type { ReactNode } from "react";
import { InboxButton } from "./InboxButton";
import { MobileNavButton } from "./mobile-nav";
import { SearchBox } from "./search/SearchBox";

/** A view's top bar: its title on the left, its own buttons, then the inbox and search (unless `tools` is off). */
export function TopBar({ actions, tools = true, children }: { actions?: ReactNode; tools?: boolean; children: ReactNode }) {
  return (
    <header className="relative flex h-14 flex-none items-center gap-2 border-b bg-topbar px-4 text-topbar-foreground max-md:px-2">
      <MobileNavButton />
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
