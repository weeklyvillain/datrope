import { unwrap, type Connection } from "@datrope/core";
import { useEffect, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSubmit } from "@/hooks/use-submit";
import { BrandIcon } from "@/lib/brand-icons";
import { client, useInstanceInfo } from "@/session";
import { useSettings } from "./settings-store";

const PROVIDERS = [
  { id: "twitch", name: "Twitch", what: "People who share the server see when you are live, with a link to your stream." },
  { id: "spotify", name: "Spotify", what: "People who share the server see what you are listening to." },
] as const;

/** Accounts linked to show what you are doing. Connecting leaves for the provider's sign-in page and comes back. */
export function ConnectionsSettings() {
  const info = useInstanceInfo();
  const [list, setList] = useState<Connection[]>();
  const { busy, error, run } = useSubmit();
  const notice = useSettings((s) => s.notice);
  const load = () => run(async () => setList(await unwrap(client.api.GET("/api/users/@me/connections")) ?? []));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const enabled = { twitch: !!info?.twitch_enabled, spotify: !!info?.spotify_enabled };
  return (
    <Card role="region" aria-label="Connections" className="gap-4 p-4">
      <h3>Connections</h3>
      {notice && <p role="status" className="m-0 rounded-md border bg-card px-3 py-2 text-sm">{notice}</p>}
      <p className="m-0 text-sm text-muted-foreground">Link an account to show others what you are up to. You can hide it again at any time.</p>
      {PROVIDERS.map((p) => {
        const c = list?.find((x) => x.provider === p.id);
        return (
          <section key={p.id} aria-label={p.name} className="grid gap-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-3">
              <BrandIcon slug={p.id} className="size-6 flex-none text-muted-foreground" />
              <div className="grid min-w-0 flex-1">
                <span className="font-semibold">{p.name}</span>
                <span className="text-sm text-muted-foreground">{c ? `Connected as ${c.account_name}` : p.what}</span>
              </div>
              {c ? (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => {
                  await unwrap(client.api.DELETE("/api/users/@me/connections/{provider}", { params: { path: { provider: p.id } } }));
                  await load();
                })}>Disconnect</Button>
              ) : enabled[p.id] && (
                <Button size="sm" disabled={busy} onClick={() => void run(async () => {
                  const { url } = await unwrap(client.api.POST("/api/users/@me/connections/{provider}", { params: { path: { provider: p.id } } }));
                  window.location.assign(url);
                })}>Connect</Button>
              )}
            </div>
            {!c && !enabled[p.id] && info && <span className="text-xs text-muted-foreground">An instance admin has to set up {p.name} first.</span>}
            {c && (
              <div className="flex items-center gap-2">
                <Switch id={`show-${p.id}`} checked={c.show_activity} disabled={busy} onCheckedChange={(on) => void run(async () => {
                  await unwrap(client.api.PATCH("/api/users/@me/connections/{provider}", { params: { path: { provider: p.id } }, body: { show_activity: on } }));
                  await load();
                })} />
                <Label htmlFor={`show-${p.id}`} className="font-normal">Show my activity</Label>
              </div>
            )}
          </section>
        );
      })}
      <ErrorText error={error} />
    </Card>
  );
}
