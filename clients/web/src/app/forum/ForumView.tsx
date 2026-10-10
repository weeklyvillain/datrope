import { Perm, hasPerm } from "@datrope/core";
import { MessagesSquare, Plus, Search } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { client, errorText, isUnread, useApp, usePerms } from "../../session";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Toggle } from "@/components/ui/toggle";
import { useWindowFocus } from "@/hooks/use-window-focus";
import { Topic } from "../ChannelView";
import { SearchPanel } from "../search/SearchPanel";
import { TopBar } from "../TopBar";
import { closePanel, openPanel, panelStore, usePanel } from "../side-panel/panel";
import { filterPosts, type PostSort } from "./filter";
import { PostDialog } from "./PostDialog";
import { PostPanel } from "./PostPanel";
import { EmojiText } from "@/chat/EmojiText";
import { PostRow } from "./PostRow";

const chip = "h-7 rounded-full px-3 text-[13px] font-normal text-muted-foreground data-[state=on]:border-foreground data-[state=on]:font-semibold data-[state=on]:text-foreground";
const note = "m-0 p-8 text-center text-sm text-muted-foreground";

/** A forum: a searchable, filterable list of titled posts; a post opens in the side panel. */
export function ForumView({ channelId }: { channelId: string }) {
  const ch = useApp((s) => s.channels[channelId]);
  const posts = useApp((s) => s.posts[channelId]);
  const loaded = !!posts;
  const perms = usePerms(channelId);
  const panel = usePanel((s) => s.panel);
  const sortId = useId();
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [sort, setSort] = useState<PostSort>("activity");
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState<string>();

  // Loads the posts (again if a fresh READY cleared them).
  useEffect(() => {
    if (loaded) return;
    client.loadPosts(channelId).then(() => setLoadError(undefined), (e) => setLoadError(errorText(e)));
  }, [channelId, loaded]);

  // Seeing the forum marks it read up to the newest message across its posts.
  const lastMessageId = useApp((s) => s.readStates[channelId]?.lastMessageId);
  const lastReadId = useApp((s) => s.readStates[channelId]?.lastReadId);
  const focused = useWindowFocus();
  useEffect(() => {
    if (lastMessageId && focused && isUnread({ lastMessageId, lastReadId })) client.ack(channelId, lastMessageId).catch(() => undefined);
  }, [channelId, lastMessageId, lastReadId, focused]);

  useEffect(() => {
    // A thread, a post, a gallery item or the threads list belongs to the channel it was opened in; a profile (and search)
    // stays open, and so does a post of this forum (opened by a jump to one of its messages).
    const p = panelStore.getState().panel;
    if (p?.kind === "threads" || p?.kind === "thread" || (p?.kind === "post" && p.forumId !== channelId) || p?.kind === "media") closePanel();
  }, [channelId]);

  const shown = useMemo(() => filterPosts(posts ?? [], { query, tag, sort }), [posts, query, tag, sort]);

  if (!ch) return <main className="grid min-h-full min-w-0 flex-1 place-items-center bg-background p-8 text-center text-muted-foreground">This channel is not available.</main>;
  const canStart = hasPerm(perms, Perm.SendMessages) && hasPerm(perms, Perm.CreateThreads);
  const openPost = panel?.kind === "post" ? panel.postId : undefined;
  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col bg-background" aria-label={ch.name}>
        <TopBar actions={canStart && <Button size="sm" onClick={() => setCreating(true)}><Plus /> New post</Button>}>
          <MessagesSquare className="size-4 flex-none text-muted-foreground" aria-hidden />
          <h2 className="flex-none"><EmojiText text={ch.name} /></h2>
          {ch.topic && <Topic channelId={channelId} name={ch.name} topic={ch.topic} canEdit={hasPerm(perms, Perm.ManageChannels)} />}
        </TopBar>

        <div className="flex flex-none flex-wrap items-center gap-2 border-b px-4 py-3">
          <div className="relative max-w-80 flex-[1_1_220px]">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input className="h-8 pl-8" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search posts" aria-label="Search posts" />
          </div>
          <div role="group" aria-label="Filter by tag" className="flex flex-wrap gap-1.5">
            <Toggle variant="outline" size="sm" className={chip} pressed={tag === null} onPressedChange={() => setTag(null)}>All</Toggle>
            {(ch.tags ?? []).map((t) => (
              <Toggle key={t} variant="outline" size="sm" className={chip} pressed={tag === t} onPressedChange={(on) => setTag(on ? t : null)}>{t}</Toggle>
            ))}
          </div>
          <span className="flex-1" />
          <label htmlFor={sortId} className="text-[13px] text-muted-foreground">Sort</label>
          <NativeSelect id={sortId} size="sm" value={sort} onChange={(e) => setSort(e.target.value as PostSort)}>
            <NativeSelectOption value="activity">Latest activity</NativeSelectOption>
            <NativeSelectOption value="newest">Newest</NativeSelectOption>
            <NativeSelectOption value="replies">Most replies</NativeSelectOption>
          </NativeSelect>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loadError ? <div className="p-4"><ErrorText error={loadError} /></div>
            : !posts ? <p className={note}>Loading…</p>
            : posts.length === 0 ? <p className={note}>No posts yet. Start one with New post.</p>
            : shown.length === 0 ? <p className={note}>No posts match.</p>
            : (
              <>
                <div aria-hidden className="grid grid-cols-[minmax(0,1fr)_72px_80px_96px] gap-4 border-b px-4 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  <span>{shown.length === 1 ? "1 post" : `${shown.length} posts`}</span>
                  <span className="text-right">People</span><span className="text-right">Replies</span><span className="text-right">Activity</span>
                </div>
                <ul role="list" aria-label="Posts" className="m-0 list-none p-0">
                  {shown.map((p) => (
                    <PostRow key={p.channel.id} post={p} selected={p.channel.id === openPost}
                      onOpen={() => openPanel({ kind: "post", postId: p.channel.id, forumId: channelId })} />
                  ))}
                </ul>
              </>
            )}
        </div>
      </main>
      {panel?.kind === "post" ? (
        <PostPanel key={panel.postId} postId={panel.postId} forumId={channelId} onClose={closePanel} />
      ) : panel?.kind === "search" ? (
        <SearchPanel />
      ) : null}
      {creating && (
        <PostDialog forumId={channelId} onClose={() => setCreating(false)}
          onSaved={(postId) => openPanel({ kind: "post", postId, forumId: channelId })} />
      )}
    </>
  );
}
