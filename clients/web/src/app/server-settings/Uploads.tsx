import { unwrap } from "@datrope/core";
import { X } from "@/components/icons";
import { useEffect, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSubmit } from "@/hooks/use-submit";
import { client } from "@/session";
import { type Row, rowsError, rowsFromRules, rulesFromRows } from "./ttl-rules";

const MB = 1024 * 1024;

/** The largest upload, and how voice is set up (instance admin). */
export function Uploads() {
  const [maxMb, setMaxMb] = useState<number>();
  const [saved, setSaved] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [rulesSaved, setRulesSaved] = useState(false);
  const { busy, error, run } = useSubmit();
  // The rules form has its own state, so its errors show under the rules.
  const rules = useSubmit();
  const ttlError = rowsError(rows);
  const setRow = (i: number, patch: Partial<Row>) => {
    setRulesSaved(false);
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  useEffect(() => {
    void run(async () => {
      const s = await unwrap(client.api.GET("/api/admin/settings"));
      setMaxMb(Math.round(s.max_upload_bytes / MB));
      setRows(rowsFromRules(s.upload_ttl_rules ?? []));
    });
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
      <section className="grid gap-2" aria-labelledby="ttl-h">
        <h3 id="ttl-h" className="text-sm font-semibold">Automatic deletion</h3>
        <p className="max-w-[68ch] text-muted-foreground">
          Large files take up space. Sent files at least this big are deleted after the time you set. Their messages stay,
          and the uploader or a moderator can keep a file forever. Applies to files sent from now on.
        </p>
        <form className="grid gap-2" onSubmit={(e) => {
          e.preventDefault();
          setRulesSaved(false);
          void rules.run(async () => {
            const s = await unwrap(client.api.PATCH("/api/admin/settings", { body: { upload_ttl_rules: rulesFromRows(rows) } }));
            setRows(rowsFromRules(s.upload_ttl_rules ?? []));
            setRulesSaved(true);
          });
        }}>
          {rows.length === 0 && <p className="text-muted-foreground">No rules: files are kept until someone deletes their message.</p>}
          {rows.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <span>Files over</span>
              <Input className="w-24" type="number" min={1} aria-label={`Rule ${i + 1} size in MB`} value={r.mb}
                onChange={(e) => setRow(i, { mb: Number(e.target.value) })} />
              <span>MB are deleted after</span>
              <Input className="w-24" type="number" min={1} max={365} aria-label={`Rule ${i + 1} days`} value={r.days}
                onChange={(e) => setRow(i, { days: Number(e.target.value) })} />
              <span>days</span>
              <Button variant="ghost" size="icon" aria-label={`Remove rule ${i + 1}`} onClick={() => {
                setRulesSaved(false);
                setRows((rs) => rs.filter((_, j) => j !== i));
              }}><X /></Button>
            </div>
          ))}
          {ttlError && <p role="alert" className="text-destructive">{ttlError}</p>}
          <ErrorText error={rules.error} />
          <div className="flex items-center gap-3">
            <Button variant="outline" disabled={rows.length >= 5} onClick={() => {
              setRulesSaved(false);
              setRows((rs) => [...rs, { mb: 100, days: 30 }]);
            }}>Add rule</Button>
            <Button type="submit" disabled={rules.busy || ttlError !== null}>Save rules</Button>
            {rulesSaved && <span role="status" className="text-muted-foreground">Saved</span>}
          </div>
        </form>
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
