import { Perm, hasPerm, unwrap, type Invite } from "@datrope/core";
import { useEffect, useId, useRef, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useSubmit } from "@/hooks/use-submit";
import { GUEST_TTLS, guestTtlShort } from "@/lib/guest";
import { client, errorText, useApp, usePerms, userName } from "@/session";

const HOUR = 3600;
const EXPIRY = [
  { label: "Never", seconds: 0 },
  { label: "1 hour", seconds: HOUR },
  { label: "1 day", seconds: 24 * HOUR },
  { label: "7 days", seconds: 7 * 24 * HOUR },
];
const USES = [0, 1, 5, 10, 25];

const inviteLink = (code: string) => `${location.origin}/invite/${code}`;

/** Copies text to the clipboard; "Copied" lasts 2 s. Without clipboard access, selects `input` (if given) and asks for a manual copy. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (text: string, input?: HTMLInputElement | null) => {
    setError(undefined);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      input?.focus();
      input?.select();
      setError(input ? "Copy the link manually." : `Copy the link manually: ${text}`);
    }
  };
  return { copied, error, copy };
}

/** Active invites (MANAGE_SERVER) and creating one (CREATE_INVITE). */
export function Invites() {
  const perms = usePerms();
  const canList = hasPerm(perms, Perm.ManageServer);
  const canCreate = hasPerm(perms, Perm.CreateInvite);
  const [invites, setInvites] = useState<Invite[]>();
  const [created, setCreated] = useState<string>();
  const [error, setError] = useState<string>();
  const load = () => {
    if (!canList) return;
    unwrap(client.api.GET("/api/server/invites")).then((v) => setInvites(v ?? [])).catch((e) => setError(errorText(e)));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [canList]);

  return (
    <>
      {canCreate && <CreateInvite onCreated={(code) => { setCreated(code); load(); }} />}
      {created && <CopyLink key={created} code={created} />}
      {canList && (
        <section className="grid gap-2" aria-labelledby="invites-active">
          <h3 id="invites-active" className="text-sm font-semibold">Active invites</h3>
          <ErrorText error={error} />
          {invites?.length === 0 ? <p className="text-muted-foreground">No active invites.</p> : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Created by</TableHead>
                  <TableHead>Uses</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invites?.map((i) => <InviteRow key={i.code} invite={i} onDeleted={load} onError={setError} />)}
              </TableBody>
            </Table>
          )}
        </section>
      )}
    </>
  );
}

function InviteRow({ invite: i, onDeleted, onError }: { invite: Invite; onDeleted: () => void; onError: (e: string) => void }) {
  const creator = useApp((s) => userName(s, i.creator_id));
  const { copied, error, copy } = useCopy();
  return (
    <TableRow>
      <TableCell>
        <code>{i.code}</code>
        {i.guest_ttl_seconds ? <Badge variant="secondary" className="ml-2">Guest · {guestTtlShort(i.guest_ttl_seconds)}</Badge> : null}
      </TableCell>
      <TableCell>{creator}</TableCell>
      <TableCell>{i.uses}{i.max_uses ? ` / ${i.max_uses}` : ""}</TableCell>
      <TableCell>{i.expires_at ? new Date(i.expires_at).toLocaleString() : "Never"}</TableCell>
      <TableCell>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" aria-label={`Copy link for ${i.code}`}
            onClick={() => void copy(inviteLink(i.code))}>
            {copied ? "Copied" : "Copy link"}
          </Button>
          <Button size="sm" variant="destructive" aria-label={`Delete invite ${i.code}`}
            onClick={() => unwrap(client.api.DELETE("/api/invites/{code}", { params: { path: { code: i.code } } }))
              .then(onDeleted).catch((e) => onError(errorText(e)))}>Delete</Button>
        </div>
        <ErrorText error={error} />
      </TableCell>
    </TableRow>
  );
}

function CreateInvite({ onCreated }: { onCreated: (code: string) => void }) {
  const id = useId();
  const [expiry, setExpiry] = useState(EXPIRY[3].seconds);
  const [uses, setUses] = useState(0);
  const [guest, setGuest] = useState(false);
  const [ttl, setTtl] = useState(GUEST_TTLS[2].seconds);
  const { busy, error, run } = useSubmit();
  return (
    <form aria-label="Create invite" className="grid gap-3" onSubmit={(e) => {
      e.preventDefault();
      void run(async () => {
        const inv = await unwrap(client.api.POST("/api/server/invites", {
          body: {
            ...(expiry ? { expires_in_seconds: expiry } : {}),
            ...(uses ? { max_uses: uses } : {}),
            ...(guest ? { guest_ttl_seconds: ttl } : {}),
          },
        }));
        onCreated(inv.code);
      });
    }}>
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-40">
          <FieldLabel htmlFor={`${id}-expiry`}>Expires after</FieldLabel>
          <NativeSelect id={`${id}-expiry`} value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
            {EXPIRY.map((x) => <NativeSelectOption key={x.seconds} value={x.seconds}>{x.label}</NativeSelectOption>)}
          </NativeSelect>
        </Field>
        <Field className="w-40">
          <FieldLabel htmlFor={`${id}-uses`}>Max uses</FieldLabel>
          <NativeSelect id={`${id}-uses`} value={uses} onChange={(e) => setUses(Number(e.target.value))}>
            {USES.map((n) => <NativeSelectOption key={n} value={n}>{n ? n : "Unlimited"}</NativeSelectOption>)}
          </NativeSelect>
        </Field>
        <Field orientation="horizontal" className="w-auto">
          <Switch id={`${id}-guest`} checked={guest} onCheckedChange={setGuest} />
          <FieldLabel htmlFor={`${id}-guest`}>Guest link</FieldLabel>
        </Field>
        {guest && (
          <Field className="w-40">
            <FieldLabel htmlFor={`${id}-ttl`}>Guest access lasts</FieldLabel>
            <NativeSelect id={`${id}-ttl`} value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
              {GUEST_TTLS.map((x) => <NativeSelectOption key={x.seconds} value={x.seconds}>{x.label}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
        )}
        <Button type="submit" disabled={busy}>Create invite</Button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}

function CopyLink({ code }: { code: string }) {
  const link = inviteLink(code);
  // Input is a plain function component on React 18 (no ref forwarding), so find it by id.
  const inputId = useId();
  const { copied, error, copy } = useCopy();
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Input id={inputId} readOnly value={link} aria-label="New invite link" className="min-w-0 flex-1" onFocus={(e) => e.target.select()} />
        <Button onClick={() => void copy(link, document.getElementById(inputId) as HTMLInputElement | null)}>{copied ? "Copied" : "Copy"}</Button>
      </div>
      <ErrorText error={error} />
    </div>
  );
}
