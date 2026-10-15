import type { ReactNode } from "react";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { cn } from "@/lib/utils";

/** An error page's body: an icon tile, a title, one line of explanation and its actions. */
export function ErrorState({ icon, title, children, actions, danger }: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  /** Tints the icon for errors that are our fault (a crash), not the user's (a bad link). */
  danger?: boolean;
}) {
  return (
    <Empty className="flex-none p-0 md:p-0">
      <EmptyHeader>
        <EmptyMedia variant="icon" className={cn(danger && "text-destructive")}>{icon}</EmptyMedia>
        <EmptyTitle role="heading" aria-level={1} className="text-heading text-foreground">{title}</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
      {actions && <EmptyContent>{actions}</EmptyContent>}
    </Empty>
  );
}
