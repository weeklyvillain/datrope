import type { Channel, CreateReminderBody, Reminder } from "@datrope/core";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { whenLabel } from "@/chat/remind-time";
import { client, errorText } from "../../session";

/** A conversation with the System account: read-only, where reminders arrive. */
export const isSystemDM = (ch?: Channel) => ch?.type === "dm" && !!ch.participants?.some((p) => p.system);

/** Sets a reminder and confirms it with an Undo toast; a failure shows as a toast and rethrows. */
export async function setReminder(body: CreateReminderBody): Promise<void> {
  try {
    const r = await client.createReminder(body);
    toast(`Reminder set for ${whenLabel(new Date(r.due_at), new Date())}`, {
      action: { label: "Undo", onClick: () => void client.deleteReminder(r.id).catch((e) => toast.error(errorText(e))) },
    });
  } catch (e) {
    toast.error(errorText(e));
    throw e;
  }
}

/** My pending reminders, refetched whenever they change. */
export function useReminders() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const reload = useCallback(() => {
    client.listReminders().then((rs) => { setReminders(rs); setError(undefined); }, (e) => setError(errorText(e))).finally(() => setLoading(false));
  }, []);
  useEffect(reload, [reload]);
  useEffect(() => client.onEvent((type) => { if (type === "REMINDERS_UPDATE") reload(); }), [reload]);
  return { reminders, loading, error };
}
