import type { ReactNode } from "react";
import { BackButton } from "./mobile/ScreenHeader";

/** A page with nothing to show but a note. On phones it keeps a back arrow. */
export function EmptyView({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-full min-w-0 flex-1 flex-col bg-background">
      <div className="flex min-h-14 flex-none items-center px-2 pt-safe md:hidden"><BackButton /></div>
      <div className="grid flex-1 place-items-center p-8 text-center text-muted-foreground">{children}</div>
    </main>
  );
}
