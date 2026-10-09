import { unwrap } from "@datrope/core";
import { useEffect, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { useSubmit } from "@/hooks/use-submit";
import { client } from "@/session";

const MB = 1024 * 1024;

/** The largest upload, and how voice is set up (instance admin). */
export function Uploads() {
  const [maxMb, setMaxMb] = useState<number>();
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useSubmit();
  useEffect(() => {
    void run(async () => setMaxMb(Math.round((await unwrap(client.api.GET("/api/admin/settings"))).max_upload_bytes / MB)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <section className="grid gap-2" aria-labelledby="uploads-h">
        <h3 id="uploads-h" className="text-sm font-semibold">Uploads</h3>
        {maxMb !== undefined && (
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => {
            e.preventDefault();
            setSaved(false);
            void run(async () => {
              const s = await unwrap(client.api.PATCH("/api/admin/settings", { body: { max_upload_bytes: maxMb * MB } }));
              setMaxMb(Math.round(s.max_upload_bytes / MB));
              setSaved(true);
            });
          }}>
            <FormField className="w-48" label="Largest upload (MB)" type="number" min={1} max={10240} required value={maxMb}
              onChange={(e) => setMaxMb(Number(e.target.value))} />
            <Button type="submit" disabled={busy}>Save</Button>
            {saved && <span role="status" className="self-center text-muted-foreground">Saved</span>}
          </form>
        )}
        <ErrorText error={error} />
      </section>
      <section className="grid gap-2" aria-labelledby="voice-h">
        <h3 id="voice-h" className="text-sm font-semibold">Voice and video</h3>
        <p className="max-w-[68ch] text-muted-foreground">
          Voice channels, screen sharing and video run on LiveKit, set up on the server with
          {" "}<code>LIVEKIT_URL</code>, <code>LIVEKIT_API_KEY</code> and <code>LIVEKIT_API_SECRET</code>.
          Without them, joining a voice channel says voice is not set up on this server.
        </p>
      </section>
    </>
  );
}
