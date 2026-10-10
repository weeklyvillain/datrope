import type { ReactNode } from "react";
import { MobileNavButton } from "./mobile-nav";

/** A page with nothing to show but a note. On phones it keeps a menu button, the only way back to the sidebar. */
export function EmptyView({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-full min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-14 flex-none items-center px-2 md:hidden"><MobileNavButton /></div>
      <div className="grid flex-1 place-items-center p-8 text-center text-muted-foreground">{children}</div>
    </main>
  );
}
