import { Minus, Plus } from "lucide-react";
import { useId, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSubmit } from "@/hooks/use-submit";
import { client, useApp, userName } from "../../session";
import { teamsStore, validDraw } from "../../voice/teams";

/** The IDs of the people in a call. */
export const useCallIds = (channelId: string) =>
  useApp(useShallow((s) => Object.values(s.voice).filter((v) => v.channel_id === channelId).map((v) => v.user_id)));

/** Sets up a team draw from the people in the call; drawing shows the result to everyone in it. */
export function TeamsDialog({ channelId, open, onOpenChange }: { channelId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-h-[90vh] overflow-y-auto sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Draw teams</DialogTitle>
        </DialogHeader>
        {open && <TeamsForm channelId={channelId} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function TeamsForm({ channelId, onDone }: { channelId: string; onDone: () => void }) {
  const id = useId();
  const inCall = useCallIds(channelId);
  const names = useApp(useShallow((s) => inCall.map((u) => userName(s, u))));
  // The last settings I drew with in this call; everyone in the call is in by default.
  const [last] = useState(() => {
    const s = teamsStore.getState().settings;
    return s?.channelId === channelId ? s : undefined;
  });
  const [teams, setTeams] = useState(last?.teams ?? 2);
  const [perTeam, setPerTeam] = useState(last?.perTeam ?? 0);
  const [out, setOut] = useState<string[]>([]); // unchecked; people who join later are in
  const picked = inCall.filter((u) => !out.includes(u));
  const invalid = validDraw({ teams, perTeam, picked: picked.length });
  const { busy, error, run } = useSubmit();

  const submit = () => run(async () => {
    await client.drawTeams(channelId, { teams, per_team: perTeam || undefined, user_ids: picked });
    teamsStore.setState({ settings: { channelId, teams, perTeam, userIds: picked } });
    onDone();
  });

  return (
    <form className="grid gap-4" onSubmit={(e) => {
      e.preventDefault();
      if (!invalid) void submit();
    }}>
      <div className="grid gap-1.5">
        <span id={`${id}-teams`} className="text-sm font-medium">Number of teams</span>
        <Stepper labelledBy={`${id}-teams`} value={teams} min={2} max={8} onChange={setTeams} less="Fewer teams" more="More teams" />
      </div>
      <div className="grid gap-1.5">
        <span id={`${id}-per`} className="text-sm font-medium">Players per team</span>
        <Stepper labelledBy={`${id}-per`} value={perTeam} min={0} max={50} onChange={setPerTeam}
          less="Fewer players per team" more="More players per team" show={(n) => (n === 0 ? "Even split" : String(n))} />
        <p className="m-0 text-xs text-muted-foreground">Leftovers sit on the bench.</p>
      </div>
      <fieldset className="m-0 grid gap-1.5 border-0 p-0">
        <legend className="flex w-full items-center gap-2 text-sm font-medium">
          Who's in
          <span className="text-xs font-normal text-muted-foreground">{picked.length} of {inCall.length} in the call</span>
          <span className="ml-auto flex gap-2">
            <Button variant="link" size="xs" className="h-auto p-0" onClick={() => setOut([])}>All</Button>
            <Button variant="link" size="xs" className="h-auto p-0" onClick={() => setOut(inCall)}>None</Button>
          </span>
        </legend>
        <ul className="m-0 grid max-h-[240px] list-none grid-cols-2 gap-x-3 gap-y-1.5 overflow-y-auto p-0">
          {inCall.map((u, i) => (
            <li key={u}>
              <label className="flex min-w-0 items-center gap-2 text-sm">
                <Checkbox checked={!out.includes(u)}
                  onCheckedChange={(c) => setOut((o) => (c === true ? o.filter((x) => x !== u) : [...o, u]))} />
                <span className="truncate">{names[i]}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      {invalid && <p className="m-0 text-xs text-muted-foreground">{invalid}</p>}
      <ErrorText error={error} />
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={busy || !!invalid}>Draw</Button>
      </DialogFooter>
    </form>
  );
}

function Stepper({ labelledBy, value, min, max, onChange, less, more, show = String }: {
  labelledBy: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  less: string;
  more: string;
  show?: (n: number) => string;
}) {
  return (
    <div className="flex items-center gap-2" role="group" aria-labelledby={labelledBy}>
      <Button variant="outline" size="icon-sm" aria-label={less} disabled={value <= min} onClick={() => onChange(value - 1)}><Minus /></Button>
      <output aria-labelledby={labelledBy} className="min-w-24 text-center text-sm tabular-nums">{show(value)}</output>
      <Button variant="outline" size="icon-sm" aria-label={more} disabled={value >= max} onClick={() => onChange(value + 1)}><Plus /></Button>
    </div>
  );
}
