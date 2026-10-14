import { Perm, hasPerm } from "@datrope/core";
import { MessagesSquare, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { client, outranksUser, useApp, usePerms } from "../../session";
import { ErrorText } from "@/components/error-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useChannelFeed } from "@/hooks/use-channel-feed";
import { useSubmit } from "@/hooks/use-submit";
import { Composer } from "../Composer";
import { MessageList, type ReplyState } from "../MessageList";
import { SidePanel } from "../side-panel/SidePanel";
import { repliesText } from "../threads";
import { PostDialog } from "./PostDialog";
import { ListSkeleton } from "@/components/loading-skeleton";

/** Inside a post nobody replies to a single message. */
const NO_REPLY: ReplyState = { replyTo: null, setReplyTo: () => undefined };

/** A forum post in the side panel: its title and tags, its body and replies, and a composer.
 *  A post uses its forum's permissions; its creator, or Manage messages above the creator, may edit or delete it. */
export function PostPanel({ postId, forumId, onClose }: { postId: string; forumId: string; onClose: () => void }) {
  const post = useApp((s) => s.posts[forumId]?.find((p) => p.channel.id === postId));
  const loaded = useApp((s) => !!s.posts[forumId]);
  const forumName = useApp((s) => s.channels[forumId]?.name);
  const meId = useApp((s) => s.me?.id);
  const creator = post?.channel.created_by;
  // Like messages: a moderator changes only posts by members they outrank (or whose author is gone).
  const outranksCreator = useApp((s) => !creator || outranksUser(s, creator));
  const perms = usePerms(forumId);
  const loadError = useChannelFeed(postId);
  const [open, setOpen] = useState<"edit" | "delete">();

  // A deleted post closes its panel.
  useEffect(() => {
    if (loaded && !post) onClose();
  }, [loaded, post, onClose]);

  if (!post) {
    return (
      <SidePanel title="Post" icon={<MessagesSquare />} onClose={onClose}>
        <ListSkeleton />
      </SidePanel>
    );
  }
  const replies = post.summary.message_count - 1; // the post body is the first message
  const canManage = hasPerm(perms, Perm.ManageMessages);
  const canEdit = creator === meId || (canManage && outranksCreator);
  const tags = post.channel.tags ?? [];
  return (
    <SidePanel title="Post" icon={<MessagesSquare />} onClose={onClose}
      subtitle={[forumName && `in #${forumName}`, replies > 0 ? repliesText(replies) : "No replies"].filter(Boolean).join(" · ")}>
      <section className="grid flex-none gap-2 border-b px-4 py-3">
        <h3 className="m-0 text-base font-semibold tracking-normal text-foreground normal-case wrap-anywhere">{post.channel.name}</h3>
        {(tags.length > 0 || canEdit) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {tags.map((t) => <Badge key={t} variant="outline">{t}</Badge>)}
            {canEdit && (
              <span className="ml-auto flex gap-1">
                <Button variant="ghost" size="xs" onClick={() => setOpen("edit")}><Pencil /> Edit</Button>
                <Button variant="ghost" size="xs" className="text-destructive" onClick={() => setOpen("delete")}><Trash2 /> Delete</Button>
              </span>
            )}
          </div>
        )}
      </section>
      <div className="flex min-h-0 flex-1 flex-col">
        {loadError ? <ErrorText error={loadError} /> : (
          <MessageList channelId={postId} canManage={canManage} canReply={false}
            canReact={hasPerm(perms, Perm.AddReactions)} reply={NO_REPLY} unreadLine={false} />
        )}
        <Composer channelId={postId} canSend={hasPerm(perms, Perm.SendMessages)} canAttach={hasPerm(perms, Perm.AttachFiles)}
          placeholder="Reply to post" label="Reply to post" reply={NO_REPLY} />
      </div>
      {open === "edit" && <PostDialog forumId={forumId} post={post} onClose={() => setOpen(undefined)} />}
      {open === "delete" && <DeletePost postId={postId} forumId={forumId} onClose={() => setOpen(undefined)} />}
    </SidePanel>
  );
}

function DeletePost({ postId, forumId, onClose }: { postId: string; forumId: string; onClose: () => void }) {
  const { busy, error, run } = useSubmit();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Delete this post?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">The post and all its replies are deleted for everyone.</p>
        <ErrorText error={error} />
        <DialogFooter>
          <Button variant="destructive" disabled={busy} onClick={() => void run(async () => {
            await client.deletePost(postId, forumId);
            onClose();
          })}>Delete</Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
