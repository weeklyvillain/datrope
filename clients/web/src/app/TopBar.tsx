import type { ReactNode } from "react";
import { InboxButton } from "./InboxButton";
import { SearchBox } from "./search/SearchBox";

/** A view's top bar: its title on the left, its own buttons, then the inbox and search (unless `tools` is off). */
export function TopBar({ actions, tools = true, children }: { actions?: ReactNode; tools?: boolean; children: ReactNode }) {
  return (
    <header className="flex h-14 flex-none items-center gap-2 border-b bg-topbar px-4 text-topbar-foreground">
      {children}
      <div className="ml-auto flex flex-none items-center gap-1">
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
