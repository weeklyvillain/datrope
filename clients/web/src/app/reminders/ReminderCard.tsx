import { channelRef, type ReminderInfo, type ReminderTarget } from "@datrope/core";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { headStamp } from "@/lib/message-time";
import { client } from "../../session";
import { openMessage } from "../jump";

export function ReminderCardView({ info, onJump }: { info: ReminderInfo; onJump: (t: ReminderTarget) => void }) {
  const { quote, target } = info;
  return (
    <div>
      <p className="m-0">Reminder{info.note && <>: <strong className="font-semibold text-foreground">{info.note}</strong></>}</p>
      {info.unavailable ? (
        <p className="m-0 mt-1 max-w-md rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground">
          <em>Message unavailable — it was deleted, or you no longer have access.</em>
        </p>
      ) : quote && target && (
        <div className="mt-1 max-w-md rounded-lg border bg-card px-3 py-2 text-sm">
          <p className="m-0 text-xs text-muted-foreground">
            {quote.author_name}{quote.channel_name && ` · #${quote.channel_name}`} · {headStamp(new Date(quote.created_at))}
          </p>
          <p className="m-0 line-clamp-3 wrap-anywhere">{quote.excerpt || "Attachment"}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => onJump(target)}>Jump to message</Button>
        </div>
      )}
    </div>
  );
}

/** The body of a reminder System delivered: the note, then the message it is about, as I may see it now. */
export function ReminderCard({ info }: { info: ReminderInfo }) {
  const navigate = useNavigate();
  return <ReminderCardView info={info}
    onJump={(t) => void openMessage(navigate, channelRef(client.store.getState(), t.channel_id), t.message_id)} />;
}
