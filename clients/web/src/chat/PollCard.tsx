import { customEmojiId, type ClientMessage, type Poll, type PublicUser } from "@datrope/core";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { client, displayName, errorText, useApp } from "@/session";
import { ErrorText } from "@/components/error-text";
import { RefButton } from "@/components/ref-button";
import { UserAvatar } from "@/components/user-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { useBriefError } from "./Reactions";
import { isEnded, nextVotes, percentages, pollFooter, winners } from "./poll";
import { sizedImage } from "@/lib/sized-image";

/** The current time, ticking every 30 s until `until` (ms) passes, so a countdown ends on time. null: no ticking. */
function useNow(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null || now >= until) return;
    const t = setTimeout(() => setNow(Date.now()), Math.min(30_000, until - now));
    return () => clearTimeout(t);
  }, [until, now]);
  return now;
}

/** An answer's emoji: a Unicode emoji, or a server emoji (nothing once it is deleted). */
export function OptionEmoji({ emoji }: { emoji: string }) {
  const id = customEmojiId(emoji);
  const custom = useApp((s) => (id ? s.emoji[id] : undefined));
  if (id) return custom ? <img {...sizedImage(custom.url, 20)} alt={`:${custom.name}:`} className="size-5 object-contain" /> : null;
  return <span className="text-lg leading-none">{emoji}</span>;
}

/** A poll inside its message: click an answer to vote, counts update live, final results once it ends. */
export function PollCard({ message, poll, canEnd }: { message: ClientMessage; poll: Poll; canEnd: boolean }) {
  const now = useNow(poll.ended || !poll.ends_at ? null : Date.parse(poll.ends_at));
  const ended = isEnded(poll, now);
  const pct = percentages(poll);
  const top = ended ? winners(poll) : [];
  const mine = poll.my_votes ?? [];
  const [busy, setBusy] = useState(false);
  const [error, showError] = useBriefError();

  const vote = (i: number) => {
    setBusy(true);
    void client.votePoll(message.channel_id, message.id, nextVotes(poll, i)).catch(showError).finally(() => setBusy(false));
  };
  const end = () => void client.endPoll(message.channel_id, message.id).catch(showError);

  return (
    <section aria-label={`Poll: ${poll.question}`} className="mt-1.5 grid max-w-md gap-2.5 rounded-lg border bg-card p-3">
      <header className="grid gap-0.5">
        <div className="flex items-start gap-2">
          <p className="m-0 flex-1 font-semibold wrap-anywhere">{poll.question}</p>
          {poll.anonymous && <Badge variant="secondary">Anonymous</Badge>}
        </div>
        <p className="m-0 text-xs text-muted-foreground">
          {ended ? "Poll closed" : poll.multi ? "Select one or more answers" : "Select one answer"}
        </p>
      </header>
      <ul className="m-0 grid list-none gap-2 p-0">
        {(poll.options ?? []).map((o, i) => {
          const chosen = mine.includes(i);
          const won = top.includes(i);
          return (
            <li key={i} className="grid gap-1">
              <div className="flex items-center gap-1.5">
                <Button variant="outline" aria-pressed={chosen} aria-label={`${o.text}, ${pct[i]}%`} disabled={ended || busy}
                  onClick={() => vote(i)}
                  className={cn("h-auto min-h-9 flex-1 justify-start gap-2 py-1.5 text-left font-normal whitespace-normal disabled:opacity-100",
                    chosen && "border-primary",
                    won && "border-primary bg-[color-mix(in_srgb,var(--primary)_14%,transparent)] font-semibold")}>
                  <span aria-hidden="true"
                    className={cn("grid size-4 flex-none place-items-center rounded-full border", chosen && "border-primary bg-primary text-primary-foreground")}>
                    {chosen && <Check className="size-3" />}
                  </span>
                  {o.emoji && <OptionEmoji emoji={o.emoji} />}
                  <span className="min-w-0 flex-1 wrap-anywhere">{o.text}</span>
                  <span className="text-xs text-muted-foreground">{pct[i]}%</span>
                </Button>
                {poll.anonymous
                  ? <span className="w-8 text-center text-sm text-muted-foreground" title={`${o.count} votes`}>{o.count}</span>
                  : <Voters message={message} position={i} label={o.text} count={o.count} />}
              </div>
              <Progress value={pct[i]} aria-label={`${o.text}: ${pct[i]}%`} className={cn("h-1.5", ended && !won && "opacity-50")} />
            </li>
          );
        })}
      </ul>
      <footer className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>{pollFooter(poll, now)}</span>
        {canEnd && !ended && (
          <Button variant="link" size="xs" className="ml-auto h-auto p-0 text-xs" onClick={end}>End poll</Button>
        )}
      </footer>
      <ErrorText error={error} />
    </section>
  );
}

/** An answer's count; in open polls it opens the list of who chose it. */
function Voters({ message, position, label, count }: { message: ClientMessage; position: number; label: string; count: number }) {
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<PublicUser[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    let live = true;
    setUsers(undefined);
    setError(undefined);
    client.pollVoters(message.channel_id, message.id, position)
      .then((u) => live && setUsers(u), (e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [open, message.channel_id, message.id, position, count]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <RefButton variant="ghost" size="sm" className="w-8 px-0 text-muted-foreground" disabled={count === 0}
          aria-label={`Voters for ${label}, ${count}`}>{count}</RefButton>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-2" align="end">
        <p className="m-0 truncate px-1 pb-1.5 text-xs font-semibold text-muted-foreground">{label}</p>
        {error ? <ErrorText error={error} /> : !users ? (
          <p className="m-0 px-1 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ul className="m-0 grid max-h-60 list-none gap-1 overflow-y-auto p-0">
            {users.map((u) => (
              <li key={u.id} className="flex items-center gap-2 px-1 text-sm">
                <UserAvatar user={u} size="sm" />
                <span className="truncate">{displayName(u)}</span>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
