import { unwrap, type Member, type PublicUser } from "@datrope/core";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorText } from "@/components/error-text";
import { useSubmit } from "@/hooks/use-submit";
import { client, displayName, useApp } from "../../session";

export function NewDMDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const members = useApp((s) => s.server?.members);
  const sv = useApp((s) => s.server?.server);
  const me = useApp((s) => s.me);
  const [picked, setPicked] = useState<string[]>([]);
  const { busy, error, run } = useSubmit();

  const people = useMemo(() => {
    // Members still behind the rules gate can't open DMs yet.
    const gated = (m: Member) => !!sv?.rules_gate && !m.accepted_rules_at && m.user.id !== sv.owner_id;
    const others: PublicUser[] = Object.values(members ?? {}).filter((m) => !gated(m)).map((m) => m.user)
      .filter((u) => u.id !== me?.id);
    return others.sort((a, b) => displayName(a).localeCompare(displayName(b)));
  }, [members, me, sv]);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < 9 ? [...p, id] : p));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>New message</DialogTitle>
        </DialogHeader>
        {people.length === 0 && <p className="text-muted-foreground">Nobody else is here yet. Invite people to message them.</p>}
        <ul className="m-0 max-h-[300px] list-none overflow-y-auto p-0">
          {people.map((u) => (
            <li key={u.id}>
              <label className="flex items-center gap-2">
                <Checkbox checked={picked.includes(u.id)} onCheckedChange={() => toggle(u.id)} />
                {displayName(u)} <span className="text-muted-foreground">@{u.username}</span>
              </label>
            </li>
          ))}
        </ul>
        <ErrorText error={error} />
        <DialogFooter>
          <Button disabled={busy || picked.length === 0} onClick={() => void run(async () => {
            const ch = await unwrap(client.api.POST("/api/dms", { body: { recipient_ids: picked } }));
            client.apply("CHANNEL_CREATE", ch);
            onClose();
            nav(`/messages/${ch.id}`);
          })}>Start conversation</Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
