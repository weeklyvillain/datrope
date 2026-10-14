import { customEmojiId, type ClientMessage, type Reaction } from "@datrope/core";
import { ActionSheet } from "@/components/action-sheet";
import { UserAvatar } from "@/components/user-avatar";
import { sizedImage } from "@/lib/sized-image";
import { useApp, userName } from "@/session";

/** Who reacted to a message, one section per reaction; the long-pressed one comes first. */
export function ReactorsSheet({ message, emoji, open, onOpenChange }: {
  message: ClientMessage; emoji: string; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const custom = useApp((s) => s.emoji);
  const shown = (message.reactions ?? [])
    .filter((r) => { const id = customEmojiId(r.emoji); return !id || !!custom[id]; })
    .sort((a, b) => Number(b.emoji === emoji) - Number(a.emoji === emoji));
  return (
    <ActionSheet open={open} onOpenChange={onOpenChange} title="Reactions">
      {shown.map((r) => <Section key={r.emoji} reaction={r} />)}
    </ActionSheet>
  );
}

function Section({ reaction: r }: { reaction: Reaction }) {
  const id = customEmojiId(r.emoji);
  const emoji = useApp((s) => (id ? s.emoji[id] : undefined));
  const ids = r.user_ids ?? [];
  const more = r.count - ids.length;
  return (
    <div role="group" aria-label={`${emoji ? `:${emoji.name}:` : r.emoji} ${r.count}`}>
      <div className="flex items-center gap-2 px-3 pb-1 pt-2 text-sm font-semibold text-muted-foreground">
        {emoji ? <img {...sizedImage(emoji.url, 20)} alt="" className="size-5 object-contain" /> : <span className="text-lg leading-none">{r.emoji}</span>}
        {r.count}
      </div>
      {ids.map((u) => <Reactor key={u} userId={u} />)}
      {more > 0 && <p className="m-0 px-3 py-2 text-sm text-muted-foreground">and {more} more</p>}
    </div>
  );
}

function Reactor({ userId }: { userId: string }) {
  const name = useApp((s) => userName(s, userId));
  const avatarUrl = useApp((s) => s.server?.members[userId]?.user.avatar_url);
  return (
    <div className="flex min-h-[44px] items-center gap-3 px-3 text-[15px]">
      <UserAvatar user={{ id: userId, username: name, avatar_url: avatarUrl }} size="md" />
      <span className="truncate">{name}</span>
    </div>
  );
}
