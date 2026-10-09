import type { Invite } from "@datrope/core";

/** The code of an unlimited, non-expiring invite I created earlier, if there is one. */
export function reusableInvite(invites: Invite[] | null | undefined, meId: string | undefined): string | undefined {
  return invites?.find((i) => i.creator_id === meId && !i.expires_at && !i.max_uses)?.code;
}
