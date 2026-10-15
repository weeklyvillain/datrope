import { unwrap } from "@datrope/core";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { useSubmit } from "@/hooks/use-submit";
import { client, useApp } from "@/session";
import { liveAFKId } from "../../voice/afk";

const TIMEOUTS = [[300, "5 minutes"], [900, "15 minutes"], [1800, "30 minutes"], [3600, "1 hour"]] as const;

/** The AFK channel: where people who haven't spoken for a while get moved (MANAGE_SERVER). */
export function VoiceAFK() {
  const sv = useApp((s) => s.server?.server);
  const voiceChannels = useApp(useShallow((s) => (s.server?.channelIds ?? []).map((id) => s.channels[id]).filter((c) => c?.type === "voice")));
  const current = useApp((s) => liveAFKId(s.server?.server.afk_channel_id ?? undefined, s.channels) ?? "");
  const [channel, setChannel] = useState(current);
  const [timeout, setTimeout_] = useState<(typeof TIMEOUTS)[number][0]>(sv?.afk_timeout_seconds ?? 900);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  // The server may load after this form mounts: follow it until the form is edited.
  useEffect(() => {
    if (dirty) return;
    setChannel(current);
    setTimeout_(sv?.afk_timeout_seconds ?? 900);
  }, [dirty, current, sv?.afk_timeout_seconds]);
  const { busy, error, run } = useSubmit();
  return (
    <section className="grid gap-3" aria-labelledby="afk-h">
      <h3 id="afk-h" className="text-sm font-semibold">AFK channel</h3>
      <p className="max-w-[68ch] text-muted-foreground">People in a voice call who haven't spoken for this long are moved here. Nobody can talk or share in the AFK channel.</p>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        void run(async () => {
          await unwrap(client.api.PATCH("/api/server", { body: { afk_channel_id: channel, afk_timeout_seconds: timeout } }));
          setDirty(false);
          setSaved(true);
        });
      }}>
        <div className="grid gap-1.5">
          <Label htmlFor="afk-channel">Channel</Label>
          <NativeSelect id="afk-channel" value={channel} onChange={(e) => { setDirty(true); setChannel(e.target.value); }}>
            <option value="">None</option>
            {voiceChannels.map((c) => <option key={c!.id} value={c!.id}>{c!.name}</option>)}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="afk-timeout">Move after</Label>
          <NativeSelect id="afk-timeout" value={timeout} onChange={(e) => { setDirty(true); setTimeout_(Number(e.target.value) as typeof timeout); }}>
            {TIMEOUTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </NativeSelect>
        </div>
        <Button type="submit" disabled={busy}>Save</Button>
        {saved && <span role="status" className="self-center text-muted-foreground">Saved</span>}
      </form>
      <ErrorText error={error} />
    </section>
  );
}
