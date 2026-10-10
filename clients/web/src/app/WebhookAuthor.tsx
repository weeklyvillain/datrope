import type { WebhookAuthor } from "@datrope/core";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { WebhookAvatar } from "@/components/webhook-avatar";

/** The tag next to a webhook message's name. */
export function WebhookBadge() {
  return <Badge variant="secondary" className="h-4 self-center rounded px-1 text-[10px] font-bold uppercase tracking-wide">Webhook</Badge>;
}

/** What clicking a webhook message's name or avatar shows. A webhook has no profile, just a name and an avatar.
 *  `children` is a single `asChild` trigger that forwards its ref. */
export function WebhookPopover({ webhook, open, onOpenChange, onInteractOutside, children }: {
  webhook: WebhookAuthor; open: boolean; onOpenChange: (open: boolean) => void; onInteractOutside?: (e: Event) => void; children: ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="right" align="start" className="grid w-64 justify-items-start gap-2" aria-label={webhook.name}
        onInteractOutside={onInteractOutside} onContextMenu={(e) => e.stopPropagation()}>
        <WebhookAvatar avatarUrl={webhook.avatar_url} size="xl" />
        <div className="flex items-center gap-2">
          <strong className="text-base font-semibold">{webhook.name}</strong>
          <WebhookBadge />
        </div>
        <p className="m-0 text-sm text-muted-foreground">Posted by a webhook: a service outside Datrope that posts into this channel.</p>
      </PopoverContent>
    </Popover>
  );
}
