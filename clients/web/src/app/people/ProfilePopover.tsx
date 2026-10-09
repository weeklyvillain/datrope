import type { PublicUser } from "@datrope/core";
import { useEffect, useState, type ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useUser } from "@/hooks/use-user";
import { displayName } from "@/session";
import { ProfileCard } from "./ProfileCard";
import { usePanel } from "../side-panel/panel";

/** A profile card in a popover. `children` is a single `asChild` trigger that forwards its ref;
 *  pass `open`/`onOpenChange` to also open it from elsewhere (an avatar next to the name). */
export function ProfilePopover({ userId, fallback, side, open, onOpenChange, onInteractOutside, children }: {
  userId: string;
  fallback?: PublicUser;
  side?: "top" | "right" | "bottom" | "left";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onInteractOutside?: (e: Event) => void;
  children: ReactNode;
}) {
  const [own, setOwn] = useState(false);
  const controlled = open !== undefined;
  const isOpen = controlled ? open : own;
  const change = (o: boolean) => (controlled ? onOpenChange?.(o) : setOwn(o));
  // Opening this person's full profile closes the popover.
  const inPanel = usePanel((s) => s.panel?.kind === "profile" && s.panel.userId === userId);
  useEffect(() => {
    if (inPanel) change(false);
  }, [inPanel]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Popover open={isOpen} onOpenChange={change}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      {isOpen && <Content userId={userId} fallback={fallback} side={side} onInteractOutside={onInteractOutside} onClose={() => change(false)} />}
    </Popover>
  );
}

function Content({ userId, fallback, side, onInteractOutside, onClose }: {
  userId: string; fallback?: PublicUser; side?: "top" | "right" | "bottom" | "left"; onInteractOutside?: (e: Event) => void; onClose: () => void;
}) {
  const user = useUser(userId, fallback);
  return (
    <PopoverContent side={side ?? "right"} align="start" className="w-[300px] overflow-hidden p-0"
      aria-label={user ? displayName(user) : "Profile"} onInteractOutside={onInteractOutside} onContextMenu={(e) => e.stopPropagation()}>
      <ProfileCard userId={userId} variant="popover" fallback={fallback} onAction={onClose} />
    </PopoverContent>
  );
}
