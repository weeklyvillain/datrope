import { Webhook as WebhookIcon } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { AvatarSize } from "@/components/user-avatar";
import { cn } from "@/lib/utils";
import { client } from "@/session";

const sizes: Record<AvatarSize, string> = { xs: "size-5", sm: "size-6", md: "size-8", lg: "size-10", xl: "size-20" };
const icons: Record<AvatarSize, string> = { xs: "size-3", sm: "size-3.5", md: "size-4", lg: "size-5", xl: "size-10" };

/** A webhook's avatar, or the webhook icon when it has none. */
export function WebhookAvatar({ avatarUrl, size = "md", className }: { avatarUrl?: string; size?: AvatarSize; className?: string }) {
  return (
    <Avatar className={cn(sizes[size], className)}>
      {avatarUrl && <AvatarImage src={client.url(avatarUrl)} alt="" />}
      <AvatarFallback aria-hidden className="bg-muted text-muted-foreground">
        <WebhookIcon className={icons[size]} />
      </AvatarFallback>
    </Avatar>
  );
}
