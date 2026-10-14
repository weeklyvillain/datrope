import type { Webhook, WebhookWithURL } from "@datrope/core";
import { Check, Copy } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { FormField } from "@/components/form-field";
import { WebhookAvatar } from "@/components/webhook-avatar";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useSubmit } from "@/hooks/use-submit";
import { client, errorText } from "../../session";

const IMAGE_TYPES = "image/png,image/jpeg,image/gif,image/webp";

/** A webhook without its secret, for the list. */
function plain({ token: _token, url: _url, ...w }: WebhookWithURL): Webhook {
  return w;
}

/** The webhooks of a webhook channel (MANAGE_WEBHOOKS): create, rename, avatar, token and delete.
 *  A URL is shown once, right after create or regenerate: the server keeps only the hash of the token. */
export function WebhooksTab({ channelId }: { channelId: string }) {
  const [hooks, setHooks] = useState<Webhook[]>();
  const [loadError, setLoadError] = useState<string>();
  const [shown, setShown] = useState<WebhookWithURL>();
  useEffect(() => {
    client.listWebhooks(channelId).then(setHooks, (e) => setLoadError(errorText(e)));
  }, [channelId]);
  const replace = (w: Webhook) => setHooks((hs) => hs?.map((h) => (h.id === w.id ? w : h)));
  return (
    <div className="grid gap-4">
      <CreateWebhook channelId={channelId} onChange={replace}
        onCreated={(w) => { setHooks((hs) => [...(hs ?? []), plain(w)]); setShown(w); }} />
      {shown && <NewUrl key={shown.url} webhook={shown} onDone={() => setShown(undefined)} />}
      <ErrorText error={loadError} />
      {hooks?.length === 0 && <p className="m-0 text-sm text-muted-foreground">No webhooks yet.</p>}
      {hooks && hooks.length > 0 && (
        <ul className="m-0 grid list-none gap-2 p-0" aria-label="Webhooks">
          {hooks.map((w) => (
            <WebhookRow key={w.id} webhook={w} onChange={replace} onRegenerated={setShown}
              onDeleted={() => {
                setHooks((hs) => hs?.filter((h) => h.id !== w.id));
                setShown((s) => (s?.id === w.id ? undefined : s));
              }} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateWebhook({ channelId, onCreated, onChange }: {
  channelId: string; onCreated: (w: WebhookWithURL) => void; onChange: (w: Webhook) => void;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0); // a new key clears the file input
  const { busy, error, run } = useSubmit();
  return (
    <form className="grid gap-3" onSubmit={(e) => {
      e.preventDefault();
      void run(async () => {
        const w = await client.createWebhook(channelId, name.trim());
        onCreated(w); // the URL shows even if the avatar upload below fails
        setName("");
        setAvatar(null);
        setFileKey((k) => k + 1);
        if (avatar) onChange(await client.uploadWebhookAvatar(w.id, avatar));
      });
    }}>
      <FormField label="Webhook name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
      <Field>
        <FieldLabel htmlFor={`${id}-avatar`}>Avatar (optional)</FieldLabel>
        <Input key={fileKey} id={`${id}-avatar`} type="file" accept={IMAGE_TYPES}
          onChange={(e) => setAvatar(e.target.files?.[0] ?? null)} />
      </Field>
      <ErrorText error={error} />
      <Button type="submit" className="justify-self-start" disabled={busy || !name.trim()}>Create webhook</Button>
    </form>
  );
}

function NewUrl({ webhook, onDone }: { webhook: WebhookWithURL; onDone: () => void }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  return (
    <Card className="gap-2 p-4">
      <Field>
        <FieldLabel htmlFor={id}>Webhook URL</FieldLabel>
        <div className="flex gap-2">
          <Input id={id} readOnly value={webhook.url} className="font-mono text-[16px] md:text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button variant="outline" onClick={() => void navigator.clipboard?.writeText(webhook.url).then(() => setCopied(true), () => undefined)}>
            {copied ? <Check /> : <Copy />}Copy URL
          </Button>
        </div>
        <FieldDescription>
          Copy it now: it is shown only once. Anyone with this URL can post in this channel as {webhook.name}.
        </FieldDescription>
      </Field>
      <Button variant="ghost" size="sm" className="justify-self-start" onClick={onDone}>Done</Button>
    </Card>
  );
}

function WebhookRow({ webhook: w, onChange, onRegenerated, onDeleted }: {
  webhook: Webhook; onChange: (w: Webhook) => void; onRegenerated: (w: WebhookWithURL) => void; onDeleted: () => void;
}) {
  const [name, setName] = useState(w.name);
  // The kind outlives `open`, so the dialog keeps its title and button while it animates closed.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirm, setConfirm] = useState<"regenerate" | "delete">("regenerate");
  const ask = (kind: "regenerate" | "delete") => { setConfirm(kind); setConfirmOpen(true); };
  const file = useRef<HTMLInputElement>(null);
  const { busy, error, run } = useSubmit();
  const deleting = confirm === "delete";
  return (
    <li className="grid gap-2 rounded-lg border bg-background p-3">
      <div className="flex items-center gap-3">
        <WebhookAvatar avatarUrl={w.avatar_url} size="lg" />
        <form className="flex min-w-0 flex-1 gap-2" onSubmit={(e) => {
          e.preventDefault();
          void run(async () => onChange(await client.renameWebhook(w.id, name.trim())));
        }}>
          <Input aria-label={`Name of ${w.name}`} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
          <Button type="submit" variant="outline" disabled={busy || !name.trim() || name.trim() === w.name}>Rename</Button>
        </form>
      </div>
      <div className="flex flex-wrap gap-2">
        <input ref={file} type="file" accept={IMAGE_TYPES} className="hidden" onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void run(async () => onChange(await client.uploadWebhookAvatar(w.id, f)));
        }} />
        <Button variant="outline" size="sm" disabled={busy} onClick={() => file.current?.click()}>Change avatar</Button>
        {w.avatar_url && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => onChange(await client.removeWebhookAvatar(w.id)))}>
            Remove avatar
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={busy} onClick={() => ask("regenerate")}>Regenerate token</Button>
        <Button variant="destructive" size="sm" disabled={busy} onClick={() => ask("delete")}>Delete</Button>
      </div>
      <ErrorText error={error} />
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deleting ? `Delete ${w.name}?` : `Regenerate the token of ${w.name}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? "Services using its URL can no longer post. The messages it already posted stay."
                : "Its current URL stops working at once. You get a new URL to give to the services that use it."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant={deleting ? "destructive" : "default"}
              onClick={() => void run(async () => {
                if (deleting) {
                  await client.deleteWebhook(w.id);
                  onDeleted();
                } else {
                  onRegenerated(await client.regenerateWebhookToken(w.id));
                }
              })}>
              {deleting ? "Delete" : "Regenerate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}