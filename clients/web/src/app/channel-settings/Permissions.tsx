import { unwrap, type Channel, type Override } from "@datrope/core";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorText } from "@/components/error-text";
import { Field, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { useSubmit } from "@/hooks/use-submit";
import { PERM_LABELS } from "../../permLabels";
import { client, displayName, useApp } from "../../session";

type Tri = "inherit" | "allow" | "deny";

export function Permissions({ ch }: { ch: Channel }) {
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
