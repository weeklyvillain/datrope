import { unwrap } from "@datrope/core";
import { useEffect, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { useSubmit } from "@/hooks/use-submit";
import { client, forgetInstanceInfo } from "@/session";

/** Outside services the instance uses (instance admin). The Klipy key is write-only. */
export function Integrations() {
  return (
    <div className="grid gap-8">
      <Klipy />
      <AppCredentials provider="twitch" name="Twitch" console="dev.twitch.tv/console"
        about="Lets channels follow streamers (a message when they go live) and members connect Twitch to show when they are live." />
      <AppCredentials provider="spotify" name="Spotify" console="developer.spotify.com/dashboard"
        about="Lets members connect Spotify to show what they are listening to." />
    </div>
  );
}

function Klipy() {
  const [configured, setConfigured] = useState<boolean>();
  const [key, setKey] = useState("");
  const { busy, error, run } = useSubmit();
  useEffect(() => {
    void run(async () => setConfigured((await unwrap(client.api.GET("/api/admin/settings"))).klipy_configured));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = (value: string) => void run(async () => {
    const s = await unwrap(client.api.PATCH("/api/admin/settings", { body: { klipy_api_key: value } }));
    forgetInstanceInfo(); // gifs_enabled changed
    setConfigured(s.klipy_configured);
    setKey("");
  });

  return (
    <section className="grid gap-2" aria-labelledby="klipy-h">
      <h3 id="klipy-h" className="text-sm font-semibold">GIFs (Klipy)</h3>
      <p className="max-w-[68ch] text-muted-foreground">
        With a Klipy API key, members can find and post GIFs with <code>/gif</code>. Searches go through this server, and
        Klipy sees a pseudonymous ID per member, never their account. Posted GIFs are stored here. Keys are free at
        klipy.com/developers.
      </p>
      {configured !== undefined && (
        <>
          <p role="status">{configured ? "A Klipy API key is set. /gif is available." : "No key is set, so /gif is hidden."}</p>
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => {
            e.preventDefault();
            save(key.trim());
          }}>
            <FormField className="w-80" label="Klipy API key" type="password" autoComplete="off" maxLength={200}
              placeholder={configured ? "Enter a new key to replace it" : undefined}
              value={key} onChange={(e) => setKey(e.target.value)} />
            <Button type="submit" disabled={busy || !key.trim()}>Save key</Button>
            {configured && <Button variant="outline" disabled={busy} onClick={() => save("")}>Remove key</Button>}
          </form>
        </>
      )}
      <ErrorText error={error} />
    </section>
  );
}

type Settings = Awaited<ReturnType<typeof getSettings>>;
const getSettings = () => unwrap(client.api.GET("/api/admin/settings"));

/** A provider's app credentials: write-only, like the Klipy key. */
function AppCredentials({ provider, name, console, about }: { provider: "twitch" | "spotify"; name: string; console: string; about: string }) {
  const [settings, setSettings] = useState<Settings>();
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const { busy, error, run } = useSubmit();
  useEffect(() => {
    void run(async () => setSettings(await getSettings()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const configured = settings?.[`${provider}_configured`];
  const save = (client_id: string, client_secret: string) => void run(async () => {
    setSettings(await unwrap(client.api.PATCH("/api/admin/settings", { body: { [provider]: { client_id, client_secret } } })));
    forgetInstanceInfo(); // twitch_enabled / spotify_enabled changed
    setClientId("");
    setSecret("");
  });
  const h = `${provider}-h`;
  return (
    <section className="grid gap-2" aria-labelledby={h}>
      <h3 id={h} className="text-sm font-semibold">{name}</h3>
      <p className="max-w-[68ch] text-muted-foreground">
        {about} Create an app at {console} and add this redirect URL to it:{" "}
        <code className="wrap-anywhere">{`${window.location.origin}/api/connections/${provider}/callback`}</code>
      </p>
      {configured !== undefined && (
        <>
          <p role="status">{configured ? `${name} credentials are set.` : `No ${name} credentials are set.`}</p>
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => {
            e.preventDefault();
            save(clientId.trim(), secret.trim());
          }}>
            <FormField className="w-64" label={`${name} client ID`} autoComplete="off" maxLength={200}
              value={clientId} onChange={(e) => setClientId(e.target.value)} />
            <FormField className="w-64" label={`${name} client secret`} type="password" autoComplete="off" maxLength={200}
              placeholder={configured ? "Enter new credentials to replace them" : undefined}
              value={secret} onChange={(e) => setSecret(e.target.value)} />
            <Button type="submit" disabled={busy || !clientId.trim() || !secret.trim()}>Save</Button>
            {configured && <Button variant="outline" disabled={busy} onClick={() => save("", "")}>Remove</Button>}
          </form>
        </>
      )}
      <ErrorText error={error} />
    </section>
  );
}
