import { AlarmClock } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PresenceDot } from "@/components/presence-dot";
import { avatarColor } from "@/lib/avatar-color";
import { cn } from "@/lib/utils";
import { sizedImage } from "@/lib/sized-image";
import { displayName, initials } from "@/session";

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

const sizes: Record<AvatarSize, string> = {
  xs: "size-5 text-[9px]",
  sm: "size-6 text-[0.65rem]",
  md: "size-8 text-xs",
  lg: "size-10 text-sm",
  xl: "size-20 text-[26px]",
};
const px: Record<AvatarSize, number> = { xs: 20, sm: 24, md: 32, lg: 40, xl: 80 };
const dots: Record<AvatarSize, string> = {
  xs: "-right-0.5 -bottom-0.5 size-2 ring-2",
  sm: "-right-0.5 -bottom-0.5 size-2.5 ring-2",
  md: "-right-0.5 -bottom-0.5 size-3 ring-2",
  lg: "-right-0.5 -bottom-0.5 size-3 ring-2",
  xl: "right-0 bottom-0 size-5 ring-4",
};

/** A person's avatar image, or their initials on a colour derived from their ID; `status` adds a presence dot. */
export function UserAvatar({ user, size = "md", status, ringClassName = "ring-card", className }: {
  user: { id: string; display_name?: string; username: string; avatar_url?: string; system?: boolean };
  size?: AvatarSize;
  status?: string;
  ringClassName?: string;
  className?: string;
}) {
  if (user.system) {
    return (
      <Avatar className={cn(sizes[size], className)}>
        <AvatarFallback aria-hidden className="bg-primary text-primary-foreground"><AlarmClock className="size-1/2" /></AvatarFallback>
      </Avatar>
    );
  }
  const avatar = (
    <Avatar className={cn(sizes[size], className)}>
      {user.avatar_url && <AvatarImage {...sizedImage(user.avatar_url, px[size])} alt="" />}
      <AvatarFallback aria-hidden className="font-semibold text-foreground text-[length:inherit]" style={{ background: avatarColor(user.id) }}>
        {initials(displayName({ display_name: user.display_name ?? "", username: user.username }))}
      </AvatarFallback>
    </Avatar>
  );
  if (status === undefined) return avatar;
  return (
    <span className="relative inline-flex flex-none">
      {avatar}
      <PresenceDot status={status} className={cn("absolute", dots[size], ringClassName)} />
    </span>
  );
}
