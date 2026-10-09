import type { PublicUser, ThreadSummary as Summary } from "@datrope/core";
import { cn } from "@/lib/utils";
import { UserAvatar } from "@/components/user-avatar";
import { useUser } from "@/hooks/use-user";
import { repliesText, timeAgo } from "./threads";

function Participant({ user, className }: { user: PublicUser; className?: string }) {
  return <UserAvatar user={useUser(user.id, user) ?? user} size="xs" className={className} />;
}

/** The participants, reply count and last reply time of a thread; with no replies it says "Open thread". */
export function ThreadSummaryLine({ summary }: { summary: Summary }) {
  const people = (summary.participants ?? []).slice(0, 3);
  return (
    <>
      {people.length > 0 && (
        <span className="flex flex-none" aria-hidden>
          {people.map((u, i) => (
            <Participant key={u.id} user={u} className={cn("ring-2 ring-card", i > 0 && "-ml-1.5")} />
          ))}
        </span>
      )}
      <span className="font-semibold text-primary">{summary.message_count > 0 ? repliesText(summary.message_count) : "Open thread"}</span>
      {summary.message_count > 0 && summary.last_message_at && (
        <span className="truncate text-muted-foreground">Last reply {timeAgo(summary.last_message_at)}</span>
      )}
    </>
  );
}

/** The link-style button under a message that has a thread; opens the thread panel. */
export function ThreadSummary({ summary, onOpen }: { summary: Summary; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen}
      className="mt-1.5 inline-flex max-w-full items-center gap-2 rounded-lg border bg-card py-1 pl-1 pr-2.5 text-left text-[13px] outline-none hover:border-ring focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
      <ThreadSummaryLine summary={summary} />
    </button>
  );
}
