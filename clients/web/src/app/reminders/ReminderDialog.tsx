import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { dayLabels, defaultPick, pickFor, pickToDate, relative, type Pick as WheelPick } from "@/chat/remind-time";
import { setReminder } from "./reminders";
import { Wheel } from "./Wheel";

export type ReminderTarget = { id: string; channel_id: string; authorName: string; excerpt: string; channelName?: string };

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0"));
const CHIPS = [["+20m", 20], ["+1h", 60], ["+3h", 180]] as const;

/** The dialog's body; split out so it renders (and tests) without the portal. */
export function ReminderForm({ message, onClose, now, initial }:
  { message?: ReminderTarget; onClose: () => void; now?: Date; initial?: WheelPick }) {
  const [base] = useState(() => now ?? new Date()); // the day wheel's "Today", frozen at open
  const [clock, setClock] = useState(base); // ticks, so the preview and the past check stay current
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const [pick, setPick] = useState<WheelPick>(() => initial ?? defaultPick(base));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const due = pickToDate(base, pick);
  const preview = relative(due, clock);
  const submit = async () => {
    if (due <= new Date()) { setClock(new Date()); return; }
    setBusy(true);
    try {
      await setReminder({ due_at: due.toISOString(), note: note.trim(), ...(message && { channel_id: message.channel_id, message_id: message.id }) });
      onClose();
    } catch {
      setBusy(false); // the toast said why
    }
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (preview) void submit(); }} className="flex flex-col gap-4">
      {message && (
        <div className="rounded-lg border bg-background px-3 py-2 text-sm">
          <p className="m-0 text-xs text-muted-foreground">{message.authorName}{message.channelName && ` · #${message.channelName}`}</p>
          <p className="m-0 line-clamp-2 wrap-anywhere">{message.excerpt || "Attachment"}</p>
        </div>
      )}
      <div className="flex items-center justify-center gap-2">
        <Wheel label="Day" className="w-32" items={dayLabels(base)} index={pick.day} onChange={(day) => setPick({ ...pick, day })} />
        <Wheel label="Hour" items={HOURS} index={pick.hour} onChange={(hour) => setPick({ ...pick, hour })} />
        <span aria-hidden className="font-semibold">:</span>
        <Wheel label="Minute" items={MINUTES} index={pick.minute / 5} onChange={(i) => setPick({ ...pick, minute: i * 5 })} />
      </div>
      <p className="m-0 text-center text-sm text-primary" aria-live="polite">{preview ?? <span className="text-destructive">That time has passed</span>}</p>
      <div className="flex justify-center gap-2">
        {CHIPS.map(([label, mins]) => (
          <Button key={label} variant="outline" size="sm" className="rounded-full"
            onClick={() => { const c = new Date(); setClock(c); setPick(pickFor(base, new Date(c.getTime() + mins * 60_000))); }}>{label}</Button>
        ))}
      </div>
      <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Note (optional)" aria-label="Note" />
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={!preview || busy}>Set reminder</Button>
      </DialogFooter>
    </form>
  );
}

/** Custom… and bare /remind: pick a day and time on wheels, up to two weeks ahead. */
export function ReminderDialog({ message, onClose, onCloseAutoFocus }:
  { message?: ReminderTarget; onClose: () => void; onCloseAutoFocus?: (e: Event) => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[400px]" onContextMenu={(e) => e.stopPropagation()} onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{message ? "Remind me about this message" : "New reminder"}</DialogTitle>
          <DialogDescription className="sr-only">Pick when System should send you a reminder.</DialogDescription>
        </DialogHeader>
        <ReminderForm message={message} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}
