import { useId } from "react";
import { useShallow } from "zustand/react/shallow";
import { ErrorText } from "@/components/error-text";
import { UserAvatar } from "@/components/user-avatar";
import { Button } from "@/components/ui/button";
import { useSubmit } from "@/hooks/use-submit";
import { useUser } from "@/hooks/use-user";
import { useApp, userName } from "../../session";
import { teamColor, useTeams } from "../../voice/teams";
import { timeAgo } from "../threads";

/** The last team draw in the call (concept C: the side panel), with Re-roll. */
export function TeamsPanel({ channelId, onReroll }: { channelId: string; onReroll: () => Promise<void> }) {
  const uid = useId();
  const draw = useTeams(channelId);
  const by = useApp((s) => (draw ? userName(s, draw.by) : ""));
  const bench = useApp(useShallow((s) => (draw?.bench ?? []).map((u) => userName(s, u))));
  const { busy, error, run } = useSubmit();
  if (!draw) return <p className="m-0 p-4 text-sm text-muted-foreground">No teams drawn yet.</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <p className="m-0 text-xs text-muted-foreground">drawn by {by} · {timeAgo(draw.at)}</p>
      {(draw.teams ?? []).map((team, i) => (
        <section key={i} aria-labelledby={`${uid}-${i}`} className="rounded-lg border bg-card p-2.5">
          <h3 id={`${uid}-${i}`} className="m-0 mb-1.5 flex items-center gap-2 text-sm font-semibold" style={{ color: teamColor(i) }}>
            <span aria-hidden className="size-2 flex-none rounded-full" style={{ background: teamColor(i) }} />
            Team {i + 1}
          </h3>
          <ul className="m-0 grid list-none gap-1 p-0">
            {(team ?? []).map((u) => <Member key={u} userId={u} />)}
          </ul>
        </section>
      ))}
      {bench.length > 0 && <p className="m-0 text-xs text-muted-foreground">Bench: {bench.join(", ")}</p>}
      <ErrorText error={error} />
      <Button disabled={busy} onClick={() => void run(onReroll)}>Re-roll</Button>
    </div>
  );
}

function Member({ userId }: { userId: string }) {
  const name = useApp((s) => userName(s, userId));
  const me = useApp((s) => s.me?.id === userId);
  const person = useUser(userId);
  return (
    <li className="flex min-w-0 items-center gap-2 text-sm">
      <UserAvatar user={person ?? { id: userId, username: name }} size="xs" />
      <span className="truncate">{name}</span>
      {me && <span className="text-xs text-muted-foreground">(you)</span>}
    </li>
  );
}
