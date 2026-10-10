import { ArrowDown, ArrowUp, Plus, Smile, X } from "lucide-react";
import { useId, useState } from "react";
import { client } from "@/session";
import { ErrorText } from "@/components/error-text";
import { FormField } from "@/components/form-field";
import { RefButton } from "@/components/ref-button";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { useSubmit } from "@/hooks/use-submit";
import { EmojiPicker, reactionKey } from "./EmojiPicker";
import { OptionEmoji } from "./PollCard";
import { DURATIONS, MAX_OPTION, MAX_OPTIONS, MAX_QUESTION, MIN_OPTIONS, buildPoll, move, type DraftOption, type PollDuration } from "./poll";

const newOption = (): DraftOption => ({ key: crypto.randomUUID(), text: "" });

/** Creates a poll in a channel. `question` prefills the question (`/poll <question>`). */
export function PollDialog({ channelId, question: initial = "", onClose }: { channelId: string; question?: string; onClose: () => void }) {
  const [question, setQuestion] = useState(initial);
  const [options, setOptions] = useState<DraftOption[]>(() => [newOption(), newOption()]);
  const [multi, setMulti] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [duration, setDuration] = useState<PollDuration | "">("24h");
  const [invalid, setInvalid] = useState<string>();
  const { busy, error, run } = useSubmit();
  const multiId = useId();
  const anonymousId = useId();
  const durationId = useId();
  const update = (key: string, patch: Partial<DraftOption>) =>
    setOptions((os) => os.map((o) => (o.key === key ? { ...o, ...patch } : o)));

  const submit = () => {
    if (busy) return;
    const poll = buildPoll({ question, options, multi, anonymous, duration });
    if ("error" in poll) return setInvalid(poll.error);
    setInvalid(undefined);
    void run(async () => {
      await client.sendPoll(channelId, poll);
      onClose();
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Create a poll</DialogTitle>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <FormField label="Question" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={MAX_QUESTION} required autoFocus />
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">Answers</legend>
            {options.map((o, i) => (
              <div key={o.key} className="flex items-center gap-1">
                <EmojiPicker onPick={(v) => update(o.key, { emoji: reactionKey(v) })} trigger={
                  <RefButton variant="outline" size="icon-sm" aria-label={`Emoji for answer ${i + 1}`} title="Emoji">
                    {o.emoji ? <OptionEmoji emoji={o.emoji} /> : <Smile />}
                  </RefButton>
                } />
                <Input aria-label={`Answer ${i + 1}`} value={o.text} maxLength={MAX_OPTION} placeholder="Type an answer"
                  onChange={(e) => update(o.key, { text: e.target.value })} />
                <Button variant="ghost" size="icon-sm" aria-label={`Move answer ${i + 1} up`} disabled={i === 0}
                  onClick={() => setOptions((os) => move(os, i, -1))}><ArrowUp /></Button>
                <Button variant="ghost" size="icon-sm" aria-label={`Move answer ${i + 1} down`} disabled={i === options.length - 1}
                  onClick={() => setOptions((os) => move(os, i, 1))}><ArrowDown /></Button>
                <Button variant="ghost" size="icon-sm" aria-label={`Remove answer ${i + 1}`} disabled={options.length <= MIN_OPTIONS}
                  onClick={() => setOptions((os) => os.filter((x) => x.key !== o.key))}><X /></Button>
              </div>
            ))}
            {options.length < MAX_OPTIONS && (
              <Button variant="outline" size="sm" className="justify-self-start" onClick={() => setOptions((os) => [...os, newOption()])}>
                <Plus />Add answer
              </Button>
            )}
          </fieldset>
          <div className="flex items-center gap-2">
            <Checkbox id={multiId} checked={multi} onCheckedChange={(c) => setMulti(c === true)} />
            <Label htmlFor={multiId}>Allow multiple answers</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id={anonymousId} checked={anonymous} onCheckedChange={(c) => setAnonymous(c === true)} />
            <Label htmlFor={anonymousId}>Anonymous poll</Label>
          </div>
          <Field>
            <FieldLabel htmlFor={durationId}>Duration</FieldLabel>
            <NativeSelect id={durationId} value={duration} onChange={(e) => setDuration(e.target.value as PollDuration | "")}>
              {DURATIONS.map((d) => <NativeSelectOption key={d.value} value={d.value}>{d.label}</NativeSelectOption>)}
              <NativeSelectOption value="">No end</NativeSelectOption>
            </NativeSelect>
          </Field>
          <ErrorText error={invalid ?? error} />
          <DialogFooter>
            <Button type="submit" disabled={busy}>Post poll</Button>
            <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
