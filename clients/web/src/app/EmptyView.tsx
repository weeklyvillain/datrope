import type { ReactNode } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { BackButton } from "./mobile/ScreenHeader";
import { TopBar } from "./TopBar";

/** A page with nothing to show but a note. On phones it keeps a back arrow; on desktop widths a top bar (title,
 *  the narrow tier's Channels and Servers buttons, the window's drag band). */
export function EmptyView({ title, children }: { title?: string; children: ReactNode }) {
  const mobile = useIsMobile();
  return (
    <main className="flex min-h-full min-w-0 flex-1 flex-col bg-background">
      {mobile ? (
        <div className="flex min-h-14 flex-none items-center px-2 pt-safe"><BackButton /></div>
      ) : (
        <TopBar tools={false}>{title && <h1 className="flex-none">{title}</h1>}</TopBar>
      )}
      <div className="grid flex-1 place-items-center p-8 text-center text-muted-foreground">{children}</div>
    </main>
  );
}
