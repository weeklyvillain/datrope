import type { Channel, ThreadListItem, ThreadUpdate } from "@datrope/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { client, errorText } from "../../session";
import { ErrorText } from "@/components/error-text";
import { ThreadSummaryLine } from "../ThreadSummary";
import { byActivity } from "../threads";
import { MessageSquare } from "lucide-react";
import { ListSkeleton } from "@/components/loading-skeleton";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { BareButton } from "@/components/bare-button";

/** A channel's threads by recent activity; picking one opens it. */
export function ThreadsList({ channelId, onOpen }: { channelId: string; onOpen: (threadId: string) => void }) {
  const [items, setItems] = useState<ThreadListItem[]>();
  const [error, setError] = useState<string>();

  // Loads can overlap (opening, then thread events); only the newest one may set the list.
  const latest = useRef(0);
  const load = useCallback(() => {
    const n = ++latest.current;
    client.listThreads(channelId).then(
      (t) => { if (n === latest.current) { setItems(byActivity(t)); setError(undefined); } },
      (e) => { if (n === latest.current) setError(errorText(e)); },
    );
  }, [channelId]);

  useEffect(() => {
    load();
    return client.onEvent((type, data) => {
      if (type === "THREAD_UPDATE" && (data as ThreadUpdate).channel_id === channelId) load();
      else if ((type === "CHANNEL_CREATE" || type === "CHANNEL_UPDATE") && (data as Channel).parent_channel_id === channelId) load();
      else if (type === "CHANNEL_DELETE") setItems((xs) => xs?.filter((t) => t.channel.id !== (data as { id: string }).id));
    });
  }, [channelId, load]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      <ErrorText error={error} />
      {!items && !error && <ListSkeleton />}
      {items?.length === 0 && <Empty className="p-6 md:p-6"><EmptyHeader><EmptyMedia variant="icon"><MessageSquare /></EmptyMedia><EmptyTitle>No threads yet</EmptyTitle><EmptyDescription>Start one from a message's menu.</EmptyDescription></EmptyHeader></Empty>}
      <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Threads in this channel">
        {items?.map((t) => (
          <li key={t.channel.id}>
            <BareButton onClick={() => onOpen(t.channel.id)}
              className="grid w-full gap-1 rounded-md border bg-background px-3 py-2 text-left outline-none hover:border-ring focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring">
              <span className="truncate font-semibold">{t.channel.name}</span>
              <span className="flex min-w-0 items-center gap-2 text-ui"><ThreadSummaryLine summary={t.summary} /></span>
            </BareButton>
          </li>
        ))}
      </ul>
    </div>
  );
}
