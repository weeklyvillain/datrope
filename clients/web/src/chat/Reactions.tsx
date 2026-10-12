import { customEmojiId, type ClientMessage, type Reaction } from "@datrope/core";
import { SmilePlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { client, errorText, useApp, userName } from "@/session";
import { ErrorText } from "@/components/error-text";
import { RefButton } from "@/components/ref-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { EmojiPicker, reactionKey } from "./EmojiPicker";
import { sizedImage } from "@/lib/sized-image";

const PILL = "h-[26px] gap-1.5 rounded-full border bg-card px-2 text-[13px] font-normal text-foreground shadow-none hover:bg-accent";

/** An error (or an already-worded message) that clears itself after a few seconds. */
export function useBriefError(): [string | undefined, (e: unknown) => void] {
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(undefined), 4000);
    return () => clearTimeout(t);
  }, [error]);
  return [error, useCallback((e: unknown) => setError(typeof e === "string" ? e : errorText(e)), [])];
}

/** The reactions row under a message, ending with an "Add a reaction" picker when I may add new ones. */
export function Reactions({ message, canAdd }: { message: ClientMessage; canAdd: boolean }) {
  const custom = useApp((s) => s.emoji);
  const meId = useApp((s) => s.me?.id);
  const [error, showError] = useBriefError();
  // Reactions with a deleted custom emoji are hidden.
  const shown = (message.reactions ?? []).filter((r) => {
    const id = customEmojiId(r.emoji);
    return !id || !!custom[id];
  });
  if (shown.length === 0) return null;

  const react = (emoji: string, add: boolean) =>
    (add ? client.react : client.unreact).call(client, message.channel_id, message.id, emoji).catch(showError);

  return (
    <>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {shown.map((r) => (
          <Pill key={r.emoji} reaction={r} mine={!!meId && !!r.user_ids?.includes(meId)} onToggle={react} />
        ))}
        {canAdd && <EmojiPicker onPick={(v) => void react(reactionKey(v), true)} trigger={
          <RefButton variant="outline" className={cn(PILL, "text-muted-foreground")} aria-label="Add a reaction" title="Add a reaction">
            <SmilePlus className="size-3.5" />
          </RefButton>
        } />}
      </div>
      <ErrorText error={error} />
    </>
  );
}

function Pill({ reaction: r, mine, onToggle }: { reaction: Reaction; mine: boolean; onToggle: (emoji: string, add: boolean) => void }) {
  const id = customEmojiId(r.emoji);
  const emoji = useApp((s) => (id ? s.emoji[id] : undefined));
  const names = useApp((s) => (r.user_ids ?? []).slice(0, 10).map((u) => userName(s, u)).join(", "));
  const name = emoji ? `:${emoji.name}:` : r.emoji;
  const label = `${name}, ${r.count} ${r.count === 1 ? "person" : "people"}${mine ? " including you" : ""}`;
  const more = r.count - Math.min(10, r.user_ids?.length ?? 0);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <RefButton variant="outline" aria-pressed={mine} aria-label={label} onClick={() => onToggle(r.emoji, !mine)}
          className={cn(PILL, mine && "border-primary bg-[color-mix(in_srgb,var(--primary)_14%,transparent)]")}>
          {emoji ? <img {...sizedImage(emoji.url, 16)} alt="" className="size-4 object-contain" /> : <span className="text-base leading-none">{r.emoji}</span>}
          {r.count}
        </RefButton>
      </TooltipTrigger>
      <TooltipContent>{names ? `${names}${more > 0 ? ` and ${more} more` : ""}` : r.count} reacted with {name}</TooltipContent>
    </Tooltip>
  );
}
