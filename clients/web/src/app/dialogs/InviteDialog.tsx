import { unwrap } from "@datrope/core";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorText } from "@/components/error-text";
import { Input } from "@/components/ui/input";
import { client, errorText } from "../../session";

const WEEK = 7 * 24 * 3600;

export function InviteDialog({ onClose }: { onClose: () => void }) {
  const [link, setLink] = useState<string>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    unwrap(client.api.POST("/api/server/invites", { body: { expires_in_seconds: WEEK } }))
      .then((inv) => setLink(`${location.origin}/invite/${inv.code}`))
      .catch((e) => setError(errorText(e)));
  }, []);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Invite people</DialogTitle>
        </DialogHeader>
        <DialogDescription className="text-base">Anyone with this link can join for the next 7 days.</DialogDescription>
        {link && (
          <div className="flex flex-wrap items-center gap-2">
            <Input readOnly value={link} aria-label="Invite link" className="flex-1" onFocus={(e) => e.target.select()} />
            <Button onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        )}
        <ErrorText error={error} />
        <Button variant="outline" onClick={onClose}>Done</Button>
      </DialogContent>
    </Dialog>
  );
}
