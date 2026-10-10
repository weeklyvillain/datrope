import { Perm, hasPerm, type ReplyRef } from "@datrope/core";
import { LayoutGrid, MessageSquare, Music, Volume2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChannelFeed } from "@/hooks/use-channel-feed";
import { useApp, usePerms } from "../../session";
import { Topic } from "../ChannelView";
import { Composer } from "../Composer";
import { usePendingJump } from "../jump";
import { MessageList } from "../MessageList";
import { SearchPanel } from "../search/SearchPanel";
import { usePanel } from "../side-panel/panel";
import { SidePanel } from "../side-panel/SidePanel";
import { TopBar } from "../TopBar";
import { EmojiText } from "@/chat/EmojiText";
import { VoiceStage, useVoiceLayout } from "./VoiceStage";
import { EmptyView } from "../EmptyView";
import { MusicPanel } from "./MusicPanel";
import { useIsMobile } from "@/hooks/use-mobile";

export function VoiceChannelView({ channelId }: { channelId: string }) {
  const ch = useApp((s) => s.channels[channelId]);
  const perms = usePerms(channelId);
  const canRead = hasPerm(perms, Perm.ReadHistory);
  const mobile = useIsMobile();
  // The chat opens beside the call, except on phones, where it would cover it.
  const [side, setSide] = useState<"chat" | "music" | null>(mobile ? null : "chat");
  const chat = side === "chat";
  const searching = usePanel((s) => s.panel?.kind === "search");
  useEffect(() => setSide(mobile ? null : "chat"), [channelId, mobile]);
  // A jump to a message here (a search result) opens the chat, whose message list runs it.
  const pendingJump = usePendingJump(channelId);
  useEffect(() => {
    if (pendingJump) setSide("chat");
  }, [pendingJump]);
  const { layout, setLayout, canStage } = useVoiceLayout(channelId);

  if (!ch) return <EmptyView>This channel is not available.</EmptyView>;
  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-background" aria-label={ch.name}>
        <TopBar actions={(
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex">
                  <Button variant="ghost" size="icon-sm" aria-label="Grid layout" aria-pressed={layout === "grid"} disabled={!canStage}
                    className={layout === "grid" ? "text-foreground" : "text-muted-foreground"}
                    onClick={() => setLayout((l) => (l === "grid" ? "stage" : "grid"))}>
                    <LayoutGrid />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{canStage ? "Grid layout" : "Grid layout (watch a screen share for the stage)"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex">
                  <Button variant="ghost" size="icon-sm" aria-label="Music" aria-pressed={side === "music"}
                    className={side === "music" ? "text-foreground" : "text-muted-foreground"}
                    onClick={() => setSide((s) => (s === "music" ? null : "music"))}>
                    <Music />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>Music</TooltipContent>
            </Tooltip>
            {canRead && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex">
                    <Button variant="ghost" size="icon-sm" aria-label="Channel chat" aria-pressed={chat}
                      className={chat ? "text-foreground" : "text-muted-foreground"} onClick={() => setSide((s) => (s === "chat" ? null : "chat"))}>
                      <MessageSquare />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Channel chat</TooltipContent>
              </Tooltip>
            )}
          </>
        )}>
          <Volume2 className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="flex-none"><EmojiText text={ch.name} /></h2>
          {ch.topic && <Topic channelId={channelId} name={ch.name} topic={ch.topic} canEdit={hasPerm(perms, Perm.ManageChannels)} />}
        </TopBar>
        <VoiceStage channelId={channelId} layout={layout} inviteTo={ch.name} />
      </main>
      {searching ? (
        <SearchPanel />
      ) : side === "music" ? (
        <SidePanel title="Music" icon={<Music />} subtitle={ch.name} onClose={() => setSide(null)}>
          <MusicPanel channelId={channelId} />
        </SidePanel>
      ) : chat && canRead && (
        <SidePanel title="Chat" subtitle={`#${ch.name}`} onClose={() => setSide(null)}>
          <VoiceChat channelId={channelId} name={ch.name} />
        </SidePanel>
      )}
    </>
  );
}

/** A voice channel's own messages, in the side panel. No threads here. */
function VoiceChat({ channelId, name }: { channelId: string; name: string }) {
  const perms = usePerms(channelId);
  const loadError = useChannelFeed(channelId);
  const [replyTo, setReplyTo] = useState<ReplyRef | null>(null);
  const reply = useMemo(() => ({ replyTo, setReplyTo }), [replyTo]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {loadError ? <ErrorText error={loadError} /> : (
        <MessageList channelId={channelId} canManage={hasPerm(perms, Perm.ManageMessages)} canReply={hasPerm(perms, Perm.SendMessages)}
          canReact={hasPerm(perms, Perm.AddReactions)} reply={reply} />
      )}
      <Composer channelId={channelId} canSend={hasPerm(perms, Perm.SendMessages)} canAttach={hasPerm(perms, Perm.AttachFiles)}
        placeholder={`Message #${name}`} label={`Message #${name}`} reply={reply} />
    </div>
  );
}
