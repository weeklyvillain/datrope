import { unwrap, type StreamAlert } from "@datrope/core";
import { Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { useSubmit } from "@/hooks/use-submit";
import { BrandIcon } from "@/lib/brand-icons";
import { client, useInstanceInfo } from "../../session";

type Platform = StreamAlert["platform"];

const PLACEHOLDER: Record<Platform, string> = {
  twitch: "Username or twitch.tv link",
  youtube: "Channel link, @handle or channel ID",
};

/** Streamers and YouTube channels this channel follows: a message when they go live or post a video. */
export function AlertsTab({ channelId }: { channelId: string }) {
  const info = useInstanceInfo();
  const [list, setList] = useState<StreamAlert[]>();
  const [platform, setPlatform] = useState<Platform>("youtube");
  const [account, setAccount] = useState("");
  const platformId = useId();
  const accountId = useId();
  const { busy, error, run } = useSubmit();
  const path = { params: { path: { id: channelId } } };
  const load = () => run(async () => setList(await unwrap(client.api.GET("/api/channels/{id}/alerts", path)) ?? []));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  return (
    <div className="grid gap-4 pt-2">
      <p className="m-0 text-sm text-muted-foreground">
        A message is posted here when a Twitch streamer goes live or a YouTube channel posts a video. Checks run every few minutes.
      </p>
      <ul className="grid list-none gap-1.5" aria-label="Followed">
        {list?.map((a) => (
          <li key={a.id} className="flex items-center gap-2.5 rounded-md border px-3 py-2">
            <BrandIcon slug={a.platform} className="size-4 flex-none text-muted-foreground" />
            <a href={a.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate">{a.display_name}</a>
            <Button variant="ghost" size="icon-sm" aria-label={`Stop following ${a.display_name}`} disabled={busy}
              onClick={() => void run(async () => {
                await unwrap(client.api.DELETE("/api/channels/{id}/alerts/{alertID}", { params: { path: { id: channelId, alertID: a.id } } }));
                setList((l) => l?.filter((x) => x.id !== a.id));
              })}><Trash2 /></Button>
          </li>
        ))}
        {list?.length === 0 && <li className="text-sm text-muted-foreground">Not following anyone yet.</li>}
      </ul>
      <form className="grid gap-3" onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const a = await unwrap(client.api.POST("/api/channels/{id}/alerts", { ...path, body: { platform, account: account.trim() } }));
          setList((l) => [...(l ?? []), a]);
          setAccount("");
        });
      }}>
        <div className="flex flex-wrap items-end gap-2">
          <Field className="w-36">
            <FieldLabel htmlFor={platformId}>Platform</FieldLabel>
            <NativeSelect id={platformId} value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
              <NativeSelectOption value="youtube">YouTube</NativeSelectOption>
              <NativeSelectOption value="twitch" disabled={!info?.twitch_enabled}>Twitch</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field className="min-w-48 flex-1">
            <FieldLabel htmlFor={accountId}>Account</FieldLabel>
            <Input id={accountId} value={account} maxLength={200} placeholder={PLACEHOLDER[platform]} onChange={(e) => setAccount(e.target.value)} />
          </Field>
          <Button type="submit" disabled={busy || !account.trim()}>Follow</Button>
        </div>
        {info && !info.twitch_enabled && <span className="text-xs text-muted-foreground">Twitch needs an instance admin to add Twitch credentials under Integrations.</span>}
      </form>
      <ErrorText error={error} />
    </div>
  );
}
