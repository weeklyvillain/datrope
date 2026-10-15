import type { Attachment } from "@datrope/core";
import { CirclePlus, Code, Reply, Send, Smile, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ReminderDialog } from "./reminders/ReminderDialog";
import { setReminder } from "./reminders/reminders";
import { openPanel } from "./side-panel/panel";
import { client, displayName, errorText, formatBytes, useApp, useInstanceInfo } from "../session";
import { ErrorText } from "@/components/error-text";
import { RefButton } from "@/components/ref-button";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useIsMobile } from "@/hooks/use-mobile";
import { MiniBarsAboveComposer } from "./mobile/MiniBars";
import { MAX_FILES, useUploads } from "@/hooks/use-uploads";
import { cn } from "@/lib/utils";
import { enterAction, isTouchOnly } from "@/lib/touch";
import { extensionForLanguage, shouldSnippet, snippetName, wrapCodeBlock } from "@/lib/code";
import { guessLanguage, loadHighlighter } from "@/lib/highlighter";
import { Autocomplete, useSuggestions, type Suggestion } from "@/chat/AutocompleteList";
import { findTrigger } from "@/chat/autocomplete";
import { availableCommands, commandPending, isCommand, runCommand, type CommandContext, type ModalKind } from "@/chat/commands";
import { EmojiPicker, emojiText } from "@/chat/EmojiPicker";
import type { ReplyState } from "./MessageList";
import { PollDialog } from "@/chat/PollDialog";
import { GifDialog } from "./GifDialog";
import { composerTools } from "./composer-tools";
import { emitEditLast, emitPresent } from "./chat-events";

const MAX_LENGTH = 4000;

export function Composer({ channelId, canSend, canAttach, placeholder, reply, label = "Message", withTitle = false, readOnlyText = "You can't send messages here." }:
  { channelId: string; canSend: boolean; canAttach: boolean; placeholder: string; reply: ReplyState; label?: string; withTitle?: boolean; readOnlyText?: string }) {
  const phone = useIsMobile();
  const tools = composerTools(phone, canAttach);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string>();
  const uploads = useUploads(channelId, { onError: setError });
  const { files, uploading, ready } = uploads;
  const picker = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const running = useRef(false); // a command (/status) is in flight
  const [pending, setPending] = useState<string>(); // what a slow command (/play) is doing
  const { replyTo, setReplyTo } = reply;
  const box = () => form.current?.querySelector("textarea");
  const selLen = () => { const el = box(); return el ? el.selectionEnd - el.selectionStart : 0; };

  // Autocomplete for the @mention or :emoji being typed at the caret.
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const trigger = useMemo(() => findTrigger(text, caret), [text, caret]);
  const gifsEnabled = useInstanceInfo()?.gifs_enabled ?? false;
  const isVoice = useApp((s) => s.channels[channelId]?.type === "voice");
  const ctx = useMemo<CommandContext>(
    () => ({
      gifsEnabled, canAttach, setStatus: (custom_status) => client.updateMe({ custom_status }),
      setReminder: (body) => setReminder(body),
      openReminders: isVoice ? undefined : () => openPanel({ kind: "reminders" }),
      music: isVoice ? {
        queue: (query) => client.queueMusic(channelId, { query }),
        control: (action) => client.controlMusic(channelId, action),
      } : undefined,
    }),
    [gifsEnabled, canAttach, isVoice, channelId],
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

  // Guessing a pasted or wrapped snippet's language needs the highlighter ready.
  useEffect(() => {
    loadHighlighter().catch(() => undefined);
  }, []);

  if (!canSend) return <>{phone && <MiniBarsAboveComposer />}<div className="flex flex-wrap items-end gap-2 px-4 pb-4 text-muted-foreground">{readOnlyText}</div></>;

  const add = (list: File[]) => {
    if (canAttach) uploads.add(list);
  };

  // `at` is where the caret goes within `value` (default: after it).
  const insert = (from: number, to: number, value: string, at = value.length) => {
    const next = (text.slice(0, from) + value + text.slice(to)).slice(0, MAX_LENGTH);
    const pos = Math.min(from + at, next.length);
    setText(next);
    setCaret(pos);
    pendingCaret.current = pos;
  };
  const pick = (s: Suggestion) => {
    if (trigger) insert(trigger.start, caret, s.insert);
  };

  // Wraps the selection (or nothing) in a ``` block, naming the language when the guess is sure.
  const wrapSelection = () => {
    const el = box();
    const from = el?.selectionStart ?? text.length;
    const to = el?.selectionEnd ?? text.length;
    const selected = text.slice(from, to);
    const guess = selected ? guessLanguage(selected) : null;
    const atLineStart = from === 0 || text[from - 1] === "\n";
    const atLineEnd = to === text.length || text[to] === "\n";
    const { value, caret: at } = wrapCodeBlock(selected, guess?.confident ? guess.lang : "", atLineStart, atLineEnd);
    if (text.length - selected.length + value.length > MAX_LENGTH) return;
    insert(from, to, value, at);
  };

  // Sends in the background, as a reply if one is pending; a failure shows under the box.
  const deliver = (content: string, attachments: Attachment[], heading?: string) => {
    const reply = replyTo ?? undefined;
    setReplyTo(null);
    void (async () => {
      // From a detached window (an old message jumped to), go back to the present first.
      // If that fails, the message is sent anyway (the store still shows my own message).
      if (client.store.getState().messages[channelId]?.hasNewer) await client.loadLatest(channelId).catch(() => undefined);
      await client.send(channelId, content, attachments, reply, heading || undefined);
    })().catch((e) => setError(errorText(e)));
  };

  const post = (content: string) => {
    const heading = withTitle ? title.trim() : "";
    setText("");
    setTitle("");
    uploads.clear();
    setError(undefined);
    deliver(content, ready, heading);
  };

  const submit = () => {
    const content = text.trim();
    if (uploading || (!content && ready.length === 0)) return;
    if (!isCommand(content)) return post(content);
    if (running.current) return;
    running.current = true;
    setPending(commandPending(content, ctx));
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
      .finally(() => {
        running.current = false;
        setPending(undefined);
      });
  };

  return (
    <>
    {phone && <MiniBarsAboveComposer />}
    <form ref={form} className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))] max-md:px-2"
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
      <div className="rounded-lg border bg-card max-md:rounded-2xl focus-within:border-ring focus-within:ring-2 focus-within:ring-ring">
        {replyTo && (
          <div className="flex items-center gap-2 rounded-t-[inherit] bg-muted py-1.5 pl-2.5 pr-1.5 text-sm text-muted-foreground">
            <Reply className="size-3.5 flex-none" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">Replying to <strong className="text-foreground">{displayName(replyTo.author)}</strong></span>
            <Button variant="ghost" size="icon-xs" aria-label="Cancel reply" onClick={() => setReplyTo(null)}><X /></Button>
          </div>
        )}
        {files.length > 0 && (
          <ul className={cn("flex list-none flex-wrap gap-1.5 border-b bg-muted px-2.5 py-1.5", !replyTo && "rounded-t-[inherit]")} aria-label="Attachments">
            {files.map((f) => (
              <li key={f.key} className={cn("inline-flex items-center gap-1.5 rounded-full border bg-card py-0.5 pl-2.5 pr-1 text-sm", f.error && "border-destructive")}>
                {f.text === undefined ? <span>{f.name}</span> : (
                  <Input key={f.name} defaultValue={f.name} aria-label="Snippet file name"
                    className="h-6 w-36 rounded-full border-0 bg-transparent px-1 py-0 text-title md:text-sm shadow-none focus-visible:ring-1"
                    onBlur={(e) => {
                      const n = snippetName(e.target.value, f.name);
                      e.target.value = n;
                      uploads.rename(f.key, n);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault(); // not a send
                        e.currentTarget.blur();
                      }
                    }} />
                )}
                <span className="text-muted-foreground">{f.error ?? (f.attachment ? formatBytes(f.size) : "Uploading…")}</span>
                {f.text !== undefined && (
                  <Button variant="ghost" size="xs" disabled={(text.length - selLen()) + f.text.length > MAX_LENGTH}
                    onClick={() => {
                      const el = box();
                      uploads.remove(f.key);
                      insert(el?.selectionStart ?? text.length, el?.selectionEnd ?? text.length, f.text!);
                    }}>
                    Paste as text
                  </Button>
                )}
                <Button variant="ghost" size="icon-xs" aria-label={`Remove ${f.name}`}
                  onClick={() => uploads.remove(f.key)}>×</Button>
              </li>
            ))}
          </ul>
        )}
        {withTitle && (
          <Input className={cn("rounded-none border-0 border-b bg-transparent px-3 font-semibold shadow-none focus-visible:ring-0", !replyTo && files.length === 0 && "rounded-t-[inherit]")}
            value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" maxLength={100} />
        )}
        <div className="flex items-end gap-1.5 p-2">
          {canAttach && (
            <input ref={picker} type="file" multiple hidden
              onChange={(e) => {
                if (e.target.files) add(Array.from(e.target.files));
                e.target.value = "";
              }} />
          )}
          {tools.inline.includes("attach") && (tools.menu.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <RefButton variant="ghost" size="icon" className="size-11 text-muted-foreground" aria-label="Attach files" title="Attach files"><CirclePlus /></RefButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" onCloseAutoFocus={(e) => e.preventDefault()}>
                <DropdownMenuItem onSelect={() => picker.current?.click()}>Upload file</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => { box()?.focus(); wrapSelection(); }}>
                  <Code /> Code block
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Attach files" title="Attach files"
              onClick={() => picker.current?.click()}>
              <CirclePlus />
            </Button>
          ))}
          <Textarea className="max-h-[40vh] min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent px-1 py-1.5 text-title shadow-none focus-visible:ring-0 max-md:min-h-[44px] max-md:py-2.5"
            value={text} placeholder={placeholder} aria-label={label} maxLength={MAX_LENGTH} rows={1}
            enterKeyHint={isTouchOnly() ? "enter" : undefined}
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
                return;
              }
              const value = e.clipboardData.getData("text/plain");
              const el = e.currentTarget;
              const room = MAX_LENGTH - (text.length - (el.selectionEnd - el.selectionStart));
              if (!shouldSnippet(value, room, canAttach)) return;
              if (files.length >= MAX_FILES && value.length <= room) return; // fits: paste natively
              e.preventDefault();
              if (el.selectionEnd > el.selectionStart) insert(el.selectionStart, el.selectionEnd, "");
              const guess = guessLanguage(value);
              uploads.addText(value, `snippet.${extensionForLanguage(guess?.confident ? guess.lang : undefined)}`);
            }}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "e") {
                e.preventDefault();
                wrapSelection();
                return;
              }
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
              if (e.key === "ArrowUp" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing && text === "" && !replyTo) {
                e.preventDefault();
                emitEditLast(channelId);
              } else if (e.key === "Escape" && replyTo) {
                e.preventDefault();
                setReplyTo(null);
              } else if (e.key === "Escape" && !e.nativeEvent.isComposing && !e.defaultPrevented) {
                // Nothing else to dismiss: mark the conversation read and jump to the present. Not prevented, so a
                // side panel's Esc still closes it.
                emitPresent(channelId);
              } else if (enterAction({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing }, isTouchOnly()) === "send") {
                e.preventDefault();
                submit();
              }
            }} />
          {tools.inline.includes("code") && (
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Code block" title="Code block (Ctrl+E)"
              onMouseDown={(e) => e.preventDefault()} onClick={wrapSelection}>
              <Code />
            </Button>
          )}
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
              <RefButton variant="ghost" size={phone ? "icon" : "icon-sm"} className={cn("text-muted-foreground", phone && "size-11")} aria-label="Emoji" title="Emoji"><Smile /></RefButton>
            } />
          {phone ? (
            <Button type="submit" size="icon" className="size-11 rounded-full bg-primary text-primary-foreground" aria-label={withTitle ? "Post" : "Send"}
              disabled={uploading || !!pending || (!text.trim() && ready.length === 0)}><Send /></Button>
          ) : (
            <Button type="submit" size="sm" disabled={uploading || !!pending || (!text.trim() && ready.length === 0)}>{withTitle ? "Post" : "Send"}</Button>
          )}
        </div>
      </div>
      </div>
      <ErrorText error={error} />
      {pending && (
        <p role="status" className="mt-1 flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
          <Spinner className="size-3.5 flex-none" aria-hidden /><span className="truncate">{pending}</span>
        </p>
      )}
    </form>
    {modal?.open === "gif" && (
      <GifDialog channelId={channelId} query={modal.query} onClose={() => setModal(null)}
        onPick={(attachment, caption) => {
          setModal(null);
          deliver(caption, [attachment]);
        }} />
    )}
    {modal?.open === "poll" && <PollDialog channelId={channelId} question={modal.query} onClose={() => setModal(null)} />}
    {modal?.open === "reminder" && <ReminderDialog onClose={() => setModal(null)} />}
    </>
  );
}
