import { Perm, hasPerm, unwrap } from "@datrope/core";
import { UserPlus } from "@/components/icons";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { client, errorText, useApp, usePerms } from "../../session";
import { reusableInvite } from "./invite";
import { useCopy } from "../server-settings/Invites";

/**
 * A dashed tile that offers an invite link to the server while the call is small. Reuses an unlimited,
 * non-expiring invite I made earlier when I may list invites; otherwise makes a new one.
 */
export function InviteTile({ channelName }: { channelName: string }) {
  const meId = useApp((s) => s.me?.id);
  const canList = hasPerm(usePerms(), Perm.ManageServer);
  const { copied, error, copy } = useCopy();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  const onClick = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      let code: string | undefined;
      if (canList) {
        const all = await unwrap(client.api.GET("/api/server/invites"));
        code = reusableInvite(all, meId);
      }
      code ??= (await unwrap(client.api.POST("/api/server/invites", { body: {} }))).code;
      await copy(`${location.origin}/invite/${code}`);
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid aspect-video place-items-center rounded-xl border border-dashed p-3">
      <div className="grid justify-items-center gap-2 text-center text-sm text-muted-foreground">
        <UserPlus className="size-5" aria-hidden />
        <span>Invite someone to {channelName}</span>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void onClick()}>{copied ? "Copied" : "Copy invite link"}</Button>
        {(failure ?? error) && <p role="alert" className="text-xs text-destructive">{failure ?? error}</p>}
      </div>
    </div>
  );
}
