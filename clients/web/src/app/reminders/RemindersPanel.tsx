import { channelRef } from "@datrope/core";
import { AlarmClock, X } from "@/components/icons";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/error-text";
import { whenLabel } from "@/chat/remind-time";
import { client, errorText } from "../../session";
import { openMessage } from "../jump";
import { SidePanel } from "../side-panel/SidePanel";
import { useReminders } from "./reminders";

/** My pending reminders, soonest first; each can be cancelled, and one about a message jumps to it. */
export function RemindersPanel({ onClose }: { onClose: () => void }) {
  const { reminders, loading, error } = useReminders();
  const navigate = useNavigate();
  const now = new Date();
  return (
    <SidePanel title="Reminders" icon={<AlarmClock />} onClose={onClose}>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <ErrorText error={error} />
        {!loading && !error && reminders.length === 0 && (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">No reminders. Use /remind or Remind me on a message.</p>
        )}
        <ul className="m-0 list-none p-0">
          {reminders.map((r) => {
            const when = whenLabel(new Date(r.due_at), now);
            const jump = r.channel_id && r.message_id && r.quote
              ? () => void openMessage(navigate, channelRef(client.store.getState(), r.channel_id!), r.message_id!) : undefined;
            return (
              <li key={r.id} className="flex items-start gap-1 rounded-md px-2 py-2 hover:bg-accent">
                <Button variant="ghost" disabled={!jump} onClick={jump}
                  className="h-auto min-w-0 flex-1 items-start justify-start gap-3 whitespace-normal p-0 text-left font-normal hover:bg-transparent disabled:pointer-events-auto disabled:cursor-default disabled:opacity-100">
                  <span className="w-28 flex-none pt-0.5 text-xs tabular-nums text-primary">{when}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{r.note || "—"}</span>
                    {r.quote && <span className="block truncate text-xs text-muted-foreground">{r.quote.author_name}{r.quote.channel_name && ` · #${r.quote.channel_name}`}</span>}
                  </span>
                </Button>
                <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`Cancel reminder ${when}`}
                  onClick={() => void client.deleteReminder(r.id).catch((e) => toast.error(errorText(e)))}>
                  <X />
                </Button>
              </li>
            );
          })}
        </ul>
      </div>
    </SidePanel>
  );
}
