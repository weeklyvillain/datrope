import type { PublicUser } from "@datrope/core";
import { Badge } from "@/components/ui/badge";

/** "Guest" next to the name of someone who joined with a guest link. */
export function GuestBadge({ user }: { user: Pick<PublicUser, "guest_expires_at"> }) {
  if (!user.guest_expires_at) return null;
  return <Badge variant="outline" className="ml-1.5 px-1.5 py-0 align-middle text-caption">Guest</Badge>;
}
