import type { PublicUser } from "@datrope/core";
import { useEffect, useState, type ReactNode } from "react";
import { Slot } from "radix-ui";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/use-mobile";
import { useUser } from "@/hooks/use-user";
import { displayName } from "@/session";
import { ProfileCard } from "./ProfileCard";
import { openProfile, usePanel } from "../side-panel/panel";

/** A profile card in a popover. `children` is a single `asChild` trigger that forwards its ref;
 *  pass `open`/`onOpenChange` to also open it from elsewhere (an avatar next to the name). */
export function ProfilePopover({ userId, fallback, side, open, onOpenChange, onInteractOutside, disabled = false, children }: {
  userId: string;
  /** Just the trigger, with no popover (the member list sheet on phones opens the full profile instead). */
  disabled?: boolean;
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
  const inPanel = usePanel((s) => s.profile === userId);
  useEffect(() => {
    if (inPanel) change(false);
  }, [inPanel]); // eslint-disable-line react-hooks/exhaustive-deps
  const phone = useIsMobile();
  // Phones: a controlled open (an avatar next to the name) opens the full profile and hands the state back.
  useEffect(() => {
    if (phone && !disabled && controlled && open) {
      openProfile(userId);
      onOpenChange?.(false);
    }
  }, [phone, disabled, controlled, open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (disabled) return <>{children}</>;
  // Phones open the full profile (the profile drawer) instead of a popover.
  if (phone) return <Slot.Root onClick={() => openProfile(userId)}>{children}</Slot.Root>;
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
