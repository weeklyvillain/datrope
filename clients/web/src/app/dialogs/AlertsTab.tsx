import { unwrap, type StreamAlert } from "@datrope/core";
import { Rss, Trash2 } from "@/components/icons";
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
  rss: "https://store.steampowered.com/feeds/news/app/730",
};

/** Streamers, YouTube channels and feeds this channel follows: a message when they go live, post a video or publish an entry. */
export function AlertsTab({ channelId }: { channelId: string }) {
  const info = useInstanceInfo();
  const [list, setList] = useState<StreamAlert[]>();
  const [platform, setPlatform] = useState<Platform>("youtube");
  const [account, setAccount] = useState("");
  const [name, setName] = useState("");
  const [titleFilter, setTitleFilter] = useState("");
  const platformId = useId();
  const accountId = useId();
  const nameId = useId();
  const filterId = useId();
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
        A message is posted here when a Twitch streamer goes live, a YouTube channel posts a video or an RSS feed has a new entry. Checks run every few minutes.
      </p>
      <ul className="grid list-none gap-1.5" aria-label="Followed">
        {list?.map((a) => (
          <li key={a.id} className="flex items-center gap-2.5 rounded-md border px-3 py-2">
            {a.platform === "rss"
              ? <Rss className="size-4 flex-none text-muted-foreground" />
              : <BrandIcon slug={a.platform} className="size-4 flex-none text-muted-foreground" />}
            <a href={a.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate">{a.display_name}</a>
            {a.title_filter && <span className="flex-none text-xs text-muted-foreground">Title contains “{a.title_filter}”</span>}
            <Button variant="ghost" size="icon-sm" aria-label={`Stop following ${a.display_name}`} disabled={busy}
              onClick={() => void run(async () => {
                await unwrap(client.api.DELETE("/api/channels/{id}/alerts/{alertID}", { params: { path: { id: channelId, alertID: a.id } } }));
                setList((l) => l?.filter((x) => x.id !== a.id));
              })}><Trash2 /></Button>
          </li>
        ))}
        {list?.length === 0 && <li className="text-sm text-muted-foreground">Not following anything yet.</li>}
      </ul>
      <form className="grid gap-3" onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const rss = platform === "rss" ? { name: name.trim() || undefined, title_filter: titleFilter.trim() || undefined } : {};
          const a = await unwrap(client.api.POST("/api/channels/{id}/alerts", { ...path, body: { platform, account: account.trim(), ...rss } }));
          setList((l) => [...(l ?? []), a]);
          setAccount("");
          setName("");
          setTitleFilter("");
        });
      }}>
        <div className="flex flex-wrap items-end gap-2">
          <Field className="w-36">
            <FieldLabel htmlFor={platformId}>Platform</FieldLabel>
            <NativeSelect id={platformId} value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
              <NativeSelectOption value="youtube">YouTube</NativeSelectOption>
              <NativeSelectOption value="twitch" disabled={!info?.twitch_enabled}>Twitch</NativeSelectOption>
              <NativeSelectOption value="rss">RSS feed</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field className="min-w-48 flex-1">
            <FieldLabel htmlFor={accountId}>{platform === "rss" ? "Feed URL" : "Account"}</FieldLabel>
            <Input id={accountId} value={account} maxLength={200} placeholder={PLACEHOLDER[platform]} onChange={(e) => setAccount(e.target.value)} />
          </Field>
          <Button type="submit" disabled={busy || !account.trim()}>Follow</Button>
        </div>
        {platform === "rss" && (
          <div className="flex flex-wrap gap-2">
            <Field className="min-w-48 flex-1">
              <FieldLabel htmlFor={nameId}>Name</FieldLabel>
              <Input id={nameId} value={name} maxLength={100} placeholder="The feed's title" onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field className="min-w-48 flex-1">
              <FieldLabel htmlFor={filterId}>Title contains</FieldLabel>
              <Input id={filterId} value={titleFilter} maxLength={100} placeholder="Every entry" onChange={(e) => setTitleFilter(e.target.value)} />
            </Field>
          </div>
        )}
        {info && !info.twitch_enabled && <span className="text-xs text-muted-foreground">Twitch needs an instance admin to add Twitch credentials under Integrations.</span>}
      </form>
      <ErrorText error={error} />
    </div>
  );
}
