import type { ReactNode } from "react";
import { BareButton } from "@/components/bare-button";
import { cn } from "@/lib/utils";
import { ProfilePopover } from "./ProfilePopover";

/** A button around a person's avatar (or name) that opens their profile popover, for rows that already have another menu. */
export function AvatarTrigger({ userId, name, side, className, children }: {
  userId: string;
  name: string;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
  children: ReactNode;
}) {
  return (
    <ProfilePopover userId={userId} side={side} fallback={{ id: userId, username: name, display_name: "", custom_status: "" }}>
      <BareButton aria-label={`Profile of ${name}`} className={cn("flex-none rounded-full", className)}>{children}</BareButton>
    </ProfilePopover>
  );
}
