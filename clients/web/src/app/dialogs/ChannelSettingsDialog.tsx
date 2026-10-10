import { Perm, hasPerm, myChannelPerms, unwrap, type Channel, type Override } from "@datrope/core";
import { useId, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorText } from "@/components/error-text";
import { Field, FieldLabel } from "@/components/ui/field";
import { FormField } from "@/components/form-field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useSubmit } from "@/hooks/use-submit";
import { TagsEditor } from "../TagsEditor";
import { PERM_LABELS } from "../../permLabels";
import { WebhooksTab } from "./WebhooksTab";
import { client, displayName, useApp } from "../../session";

type Tri = "inherit" | "allow" | "deny";

export function ChannelSettingsDialog({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const ch = useApp((s) => s.channels[channelId]);
  const [tab, setTab] = useState<"general" | "permissions" | "webhooks">("general");
  const canWebhooks = useApp((s) => s.channels[channelId]?.type === "webhook" && hasPerm(myChannelPerms(s, channelId), Perm.ManageWebhooks));
  if (!ch) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{`#${ch.name} settings`}</DialogTitle>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="permissions">Permissions</TabsTrigger>
            {canWebhooks && <TabsTrigger value="webhooks">Webhooks</TabsTrigger>}
          </TabsList>
          <TabsContent value="general">
            <General ch={ch} onClose={onClose} />
          </TabsContent>
          <TabsContent value="permissions">
            <Permissions ch={ch} />
          </TabsContent>
          {canWebhooks && (
            <TabsContent value="webhooks">
              <WebhooksTab channelId={ch.id} />
            </TabsContent>
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function General({ ch, onClose }: { ch: Channel; onClose: () => void }) {
  const nav = useNavigate();
  const id = useId();
  const [name, setName] = useState(ch.name);
  const [topic, setTopic] = useState(ch.topic);
  const [category, setCategory] = useState(ch.category_id ?? "");
  const [tags, setTags] = useState(ch.tags ?? []);
  const [requireTag, setRequireTag] = useState(ch.require_tag);
  const byId = useApp((s) => s.server?.categories);
  const categories = useMemo(() => Object.values(byId ?? {}).sort((a, b) => a.position - b.position), [byId]);
  const { busy, error, run } = useSubmit();
  const path = { params: { path: { id: ch.id } } };
  // A new category puts the channel at the end of that group.
  const move = category === (ch.category_id ?? "") ? {} : category ? { category_id: category } : { clear_category: true };
  return (
    <form className="grid gap-3" onSubmit={(e) => {
      e.preventDefault();
      void run(async () => {
        client.apply("CHANNEL_UPDATE", await unwrap(client.api.PATCH("/api/channels/{id}", { ...path, body: { name, topic, ...move, ...(ch.type === "forum" && { tags, require_tag: requireTag && tags.length > 0 }) } })));
        onClose();
      });
    }}>
      <FormField label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
      <Field>
        <FieldLabel htmlFor={`${id}-topic`}>Topic</FieldLabel>
        <Textarea id={`${id}-topic`} value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={1024} rows={3}
          className="max-h-48" />
      </Field>
      {ch.type !== "welcome" && categories.length > 0 && (
        <Field>
          <FieldLabel htmlFor={`${id}-category`}>Category</FieldLabel>
          <NativeSelect id={`${id}-category`} value={category} onChange={(e) => setCategory(e.target.value)}>
            <NativeSelectOption value="">No category</NativeSelectOption>
            {categories.map((c) => <NativeSelectOption key={c.id} value={c.id}>{c.name}</NativeSelectOption>)}
          </NativeSelect>
        </Field>
      )}
      {ch.type === "forum" && (
        <>
          <Field>
            <FieldLabel htmlFor={`${id}-tags`}>Tags</FieldLabel>
            <TagsEditor id={`${id}-tags`} value={tags} onChange={setTags} />
          </Field>
          <div className="flex items-center gap-2">
            <Checkbox id={`${id}-require-tag`} checked={requireTag && tags.length > 0} disabled={tags.length === 0}
                  onCheckedChange={(v) => setRequireTag(v === true)} />
            <Label htmlFor={`${id}-require-tag`}>Require a tag on new posts</Label>
          </div>
        </>
      )}
      <ErrorText error={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy}>Save</Button>
        {ch.type !== "welcome" && <Button variant="destructive" disabled={busy} onClick={() => {
          if (!window.confirm(`Delete #${ch.name} and all its messages?`)) return;
          void run(async () => {
            await unwrap(client.api.DELETE("/api/channels/{id}", path));
            client.apply("CHANNEL_DELETE", { id: ch.id });
            onClose();
            nav("/");
          });
        }}>Delete channel</Button>}
      </div>
    </form>
  );
}

function Permissions({ ch }: { ch: Channel }) {
  const id = useId();
  const cs = useApp((s) => s.server);
  const [target, setTarget] = useState(`role:${cs?.server.id ?? ""}`);
  const [targetType, targetId] = target.split(":") as ["role" | "member", string];
  const existing = (ch.overrides ?? []).find((o) => o.target_type === targetType && o.target_id === targetId);
  const [draft, setDraft] = useState<Record<number, Tri>>(() => toTri(existing));
  const { busy, error, run } = useSubmit();

  const targets = useMemo(() => [
    ...Object.values(cs?.roles ?? {}).sort((a, b) => a.position - b.position)
      .map((r) => ({ key: `role:${r.id}`, label: r.name })),
    ...Object.values(cs?.members ?? {}).map((m) => ({ key: `member:${m.user.id}`, label: `@${displayName(m.user)}` })),
  ], [cs]);

  const pick = (key: string) => {
    const [t, i] = key.split(":");
    setTarget(key);
    setDraft(toTri((ch.overrides ?? []).find((o) => o.target_type === t && o.target_id === i)));
  };
  const path = { params: { path: { id: ch.id, targetType, targetID: targetId } } };

  return (
    <Card className="gap-3 p-4">
      <Field>
        <FieldLabel htmlFor={`${id}-target`}>Role or member</FieldLabel>
        <NativeSelect id={`${id}-target`} value={target} onChange={(e) => pick(e.target.value)}>
          {targets.map((t) => <NativeSelectOption key={t.key} value={t.key}>{t.label}</NativeSelectOption>)}
        </NativeSelect>
      </Field>
      <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5">
        {PERM_LABELS.filter((p) => p.channel).map((p) => (
          <label key={p.flag} className="contents">
            <span>{p.label}</span>
            <NativeSelect aria-label={p.label} value={draft[p.flag] ?? "inherit"} onChange={(e) => setDraft({ ...draft, [p.flag]: e.target.value as Tri })}>
              <NativeSelectOption value="inherit">Inherit</NativeSelectOption>
              <NativeSelectOption value="allow">Allow</NativeSelectOption>
              <NativeSelectOption value="deny">Deny</NativeSelectOption>
            </NativeSelect>
          </label>
        ))}
      </div>
      <ErrorText error={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy} onClick={() => void run(async () => {
          const allow = sum(draft, "allow");
          const deny = sum(draft, "deny");
          client.apply("CHANNEL_UPDATE", await unwrap(client.api.PUT("/api/channels/{id}/overrides/{targetType}/{targetID}", { ...path, body: { allow, deny } })));
        })}>Save permissions</Button>
        {existing && (
          <Button variant="outline" disabled={busy} onClick={() => void run(async () => {
            await unwrap(client.api.DELETE("/api/channels/{id}/overrides/{targetType}/{targetID}", path));
            client.apply("CHANNEL_UPDATE", { ...ch, overrides: (ch.overrides ?? []).filter((o) => o !== existing) });
            setDraft({});
          })}>Reset to inherit</Button>
        )}
      </div>
    </Card>
  );
}

function toTri(o?: Override): Record<number, Tri> {
  const out: Record<number, Tri> = {};
  for (const p of PERM_LABELS) {
    if (o && o.allow & p.flag) out[p.flag] = "allow";
    else if (o && o.deny & p.flag) out[p.flag] = "deny";
  }
  return out;
}

function sum(draft: Record<number, Tri>, want: Tri): number {
  return Object.entries(draft).reduce((acc, [flag, v]) => (v === want ? acc | Number(flag) : acc), 0);
}
