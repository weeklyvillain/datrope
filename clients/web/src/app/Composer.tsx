import type { Attachment } from "@datrope/core";
import { CirclePlus, Reply, Smile, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { client, displayName, errorText, formatBytes, instanceInfo, useInstanceInfo } from "../session";
import { ErrorText } from "@/components/error-text";
import { RefButton } from "@/components/ref-button";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Autocomplete, useSuggestions, type Suggestion } from "@/chat/AutocompleteList";
import { findTrigger } from "@/chat/autocomplete";
import { availableCommands, isCommand, runCommand, type CommandContext, type ModalKind } from "@/chat/commands";
import { EmojiPicker, emojiText } from "@/chat/EmojiPicker";
import type { ReplyState } from "./MessageList";
import { PollDialog } from "@/chat/PollDialog";
import { GifDialog } from "./GifDialog";

const MAX_FILES = 10; // the server's limit per message
const MAX_LENGTH = 4000;

interface PendingFile {
  key: string;
  name: string;
  size: number;
  attachment?: Attachment; // set once uploaded
  error?: string;
}

export function Composer({ channelId, canSend, canAttach, placeholder, reply, label = "Message", readOnlyText = "You can't send messages here." }:
  { channelId: string; canSend: boolean; canAttach: boolean; placeholder: string; reply: ReplyState; label?: string; readOnlyText?: string }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [error, setError] = useState<string>();
  const picker = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const running = useRef(false); // a command (/status) is in flight
  const { replyTo, setReplyTo } = reply;
  const box = () => form.current?.querySelector("textarea");

  // Autocomplete for the @mention or :emoji being typed at the caret.
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const trigger = useMemo(() => findTrigger(text, caret), [text, caret]);
  const gifsEnabled = useInstanceInfo()?.gifs_enabled ?? false;
  const ctx = useMemo<CommandContext>(
    () => ({ gifsEnabled, canAttach, setStatus: (custom_status) => client.updateMe({ custom_status }) }),
    [gifsEnabled, canAttach],
  );
  const commands = useMemo(() => availableCommands(ctx), [ctx]);
  const suggestions = useSuggestions(channelId, trigger, commands);
  const [modal, setModal] = useState<{ open: ModalKind; query: string } | null>(null); // opened by /gif and /poll
  const [dismissedAt, setDismissedAt] = useState<number | null>(null); // Escape closes the list for that trigger
  const [active, setActive] = useState(0);
  const listOpen = !!trigger && suggestions.length > 0 && dismissedAt !== trigger.start;
  const activeIndex = Math.min(active, suggestions.length - 1);
  useEffect(() => setActive(0), [trigger?.kind, trigger?.query]);
  useEffect(() => {
    if (!trigger) setDismissedAt(null); // a later trigger at the same place opens again
  }, [trigger]);

  // After an insert, put the caret right after the inserted text.
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    box()?.focus();
    box()?.setSelectionRange(at, at);
  }, [text]);

  // Starting a reply moves focus to the message box.
  useEffect(() => {
    if (replyTo) box()?.focus();
  }, [replyTo]);

  if (!canSend) return <div className="flex flex-wrap items-end gap-2 px-4 pb-4 text-muted-foreground">{readOnlyText}</div>;

  const uploading = files.some((f) => !f.attachment && !f.error);
  const ready = files.flatMap((f) => (f.attachment ? [f.attachment] : []));
  const update = (key: string, patch: Partial<PendingFile>) =>
    setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const add = (list: File[]) => {
    if (!canAttach) return;
    const room = MAX_FILES - files.length;
    if (list.length > room) setError(`You can attach up to ${MAX_FILES} files`);
    for (const file of list.slice(0, Math.max(0, room))) {
      const key = crypto.randomUUID();
      setFiles((fs) => [...fs, { key, name: file.name, size: file.size }]);
      void (async () => {
        try {
          const { max_upload_bytes: max } = await instanceInfo();
          if (file.size > max) {
            update(key, { error: `Over the ${formatBytes(max)} limit` });
            return;
          }
          update(key, { attachment: await client.upload(channelId, file, file.name) });
        } catch (e) {
          update(key, { error: errorText(e) });
        }
      })();
    }
  };

  const insert = (from: number, to: number, value: string) => {
    const next = (text.slice(0, from) + value + text.slice(to)).slice(0, MAX_LENGTH);
    const at = Math.min(from + value.length, next.length);
    setText(next);
    setCaret(at);
    pendingCaret.current = at;
  };
  const pick = (s: Suggestion) => {
    if (trigger) insert(trigger.start, caret, s.insert);
  };

  // Sends in the background, as a reply if one is pending; a failure shows under the box.
  const deliver = (content: string, attachments: Attachment[]) => {
    const reply = replyTo ?? undefined;
    setReplyTo(null);
    void (async () => {
      // From a detached window (an old message jumped to), go back to the present first.
      // If that fails, the message is sent anyway (the store still shows my own message).
      if (client.store.getState().messages[channelId]?.hasNewer) await client.loadLatest(channelId).catch(() => undefined);
      await client.send(channelId, content, attachments, reply);
    })().catch((e) => setError(errorText(e)));
  };

  const post = (content: string) => {
    setText("");
    setFiles([]);
    setError(undefined);
    deliver(content, ready);
  };

  const submit = () => {
    const content = text.trim();
    if (uploading || (!content && ready.length === 0)) return;
    if (!isCommand(content)) return post(content);
    if (running.current) return;
    running.current = true;
    void runCommand(content, ctx)
      .then((result) => {
        if (!result) return post(content);
        if ("error" in result) return setError(result.error); // keep the text for fixing
        if ("send" in result) return post(result.send);
        setText(""); // done, or a modal takes over
        setError(undefined);
        if ("open" in result) setModal({ open: result.open, query: result.query ?? "" });
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => { running.current = false; });
  };

  return (
    <>
    <form ref={form} className="px-4 pb-4"
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      onDragOver={(e) => { if (canAttach && e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDrop={(e) => {
        if (!canAttach || e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        add(Array.from(e.dataTransfer.files));
      }}>
      <div className="relative">
      {listOpen && (
        <Autocomplete id={listId} kind={trigger.kind} items={suggestions} active={activeIndex} onPick={pick} onHover={setActive} />
      )}
      <div className="overflow-hidden rounded-lg border bg-card focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
        {replyTo && (
          <div className="flex items-center gap-2 bg-muted py-1.5 pl-2.5 pr-1.5 text-sm text-muted-foreground">
            <Reply className="size-3.5 flex-none" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">Replying to <strong className="text-foreground">{displayName(replyTo.author)}</strong></span>
            <Button variant="ghost" size="icon-xs" aria-label="Cancel reply" onClick={() => setReplyTo(null)}><X /></Button>
          </div>
        )}
        {files.length > 0 && (
          <ul className="flex list-none flex-wrap gap-1.5 border-b bg-muted px-2.5 py-1.5" aria-label="Attachments">
            {files.map((f) => (
              <li key={f.key} className={cn("inline-flex items-center gap-1.5 rounded-full border bg-card py-0.5 pl-2.5 pr-1 text-sm", f.error && "border-destructive")}>
                <span>{f.name}</span>
                <span className="text-muted-foreground">{f.error ?? (f.attachment ? formatBytes(f.size) : "Uploading…")}</span>
                <Button variant="ghost" size="icon-xs" aria-label={`Remove ${f.name}`}
                  onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}>×</Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-1.5 p-2">
          {canAttach && (
            <>
              <input ref={picker} type="file" multiple hidden
                onChange={(e) => {
                  if (e.target.files) add(Array.from(e.target.files));
                  e.target.value = "";
                }} />
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Attach files" title="Attach files"
                onClick={() => picker.current?.click()}>
                <CirclePlus />
              </Button>
            </>
          )}
          <Textarea className="max-h-[40vh] min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent px-1 py-1.5 shadow-none focus-visible:ring-0"
            value={text} placeholder={placeholder} aria-label={label} maxLength={MAX_LENGTH} rows={1}
            role="combobox" aria-expanded={listOpen} aria-autocomplete="list" aria-controls={listOpen ? listId : undefined}
            aria-activedescendant={listOpen ? `${listId}-${activeIndex}` : undefined}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
              client.typing(channelId).catch(() => undefined);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onPaste={(e) => {
              const pasted = Array.from(e.clipboardData.files);
              if (canAttach && pasted.length > 0) {
                e.preventDefault();
                add(pasted);
              }
            }}
            onKeyDown={(e) => {
              if (listOpen) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const n = suggestions.length;
                  setActive((activeIndex + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
                  return;
                }
                if (!e.nativeEvent.isComposing && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
                  e.preventDefault();
                  pick(suggestions[activeIndex]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDismissedAt(trigger.start);
                  return;
                }
              }
              if (e.key === "Escape" && replyTo) {
                e.preventDefault();
                setReplyTo(null);
              } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }} />
          <EmojiPicker
            onPick={(v) => {
              const el = box();
              insert(el?.selectionStart ?? text.length, el?.selectionEnd ?? text.length, emojiText(v));
            }}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              box()?.focus();
            }}
            trigger={
              <RefButton variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Emoji" title="Emoji"><Smile /></RefButton>
            } />
          <Button type="submit" size="sm" disabled={uploading || (!text.trim() && ready.length === 0)}>Send</Button>
        </div>
      </div>
      </div>
      <ErrorText error={error} />
    </form>
    {modal?.open === "gif" && (
      <GifDialog channelId={channelId} query={modal.query} onClose={() => setModal(null)}
        onPick={(attachment, caption) => {
          setModal(null);
          deliver(caption, [attachment]);
        }} />
    )}
    {modal?.open === "poll" && <PollDialog channelId={channelId} question={modal.query} onClose={() => setModal(null)} />}
    </>
  );
}
