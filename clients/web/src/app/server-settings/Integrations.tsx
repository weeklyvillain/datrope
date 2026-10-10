import { unwrap } from "@datrope/core";
import { useEffect, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { useSubmit } from "@/hooks/use-submit";
import { client, forgetInstanceInfo } from "@/session";

/** Outside services the instance uses (instance admin). The Klipy key is write-only. */
export function Integrations() {
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
