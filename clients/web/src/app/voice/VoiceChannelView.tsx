import { Perm, hasPerm, type ReplyRef } from "@datrope/core";
import { LayoutGrid, MessageSquare, Volume2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChannelFeed } from "@/hooks/use-channel-feed";
import { useApp, usePerms } from "../../session";
import { Topic } from "../ChannelView";
import { Composer } from "../Composer";
import { MessageList } from "../MessageList";
import { ProfilePanel } from "../people/ProfilePanel";
import { closePanel, usePanel } from "../side-panel/panel";
import { SidePanel } from "../side-panel/SidePanel";
import { SoundboardButton } from "./SoundboardPanel";
import { VoiceStage, useVoiceLayout } from "./VoiceStage";

export function VoiceChannelView({ channelId }: { channelId: string }) {
  const ch = useApp((s) => s.channels[channelId]);
  const perms = usePerms(channelId);
  const canRead = hasPerm(perms, Perm.ReadHistory);
  const [chat, setChat] = useState(true);
  const profile = usePanel((s) => (s.panel?.kind === "profile" ? s.panel.userId : undefined));
  useEffect(() => setChat(true), [channelId]);
  const { layout, setLayout, canStage } = useVoiceLayout(channelId);

  if (!ch) return <main className="grid min-h-full min-w-0 flex-1 place-items-center bg-background p-8 text-center text-muted-foreground">This channel is not available.</main>;
  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-background" aria-label={ch.name}>
        <header className="flex h-14 flex-none items-center gap-2 border-b bg-card px-4">
          <Volume2 className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="flex-none">{ch.name}</h2>
          {ch.topic && <Topic channelId={channelId} name={ch.name} topic={ch.topic} canEdit={hasPerm(perms, Perm.ManageChannels)} />}
          <span className="ml-auto flex items-center gap-1">
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
            <SoundboardButton />
          {canRead && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex">
                  <Button variant="ghost" size="icon-sm" aria-label="Channel chat" aria-pressed={chat}
                    className={chat ? "text-foreground" : "text-muted-foreground"} onClick={() => setChat((c) => !c)}>
                    <MessageSquare />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>Channel chat</TooltipContent>
            </Tooltip>
          )}
          </span>
        </header>
        <VoiceStage channelId={channelId} layout={layout} inviteTo={ch.name} />
      </main>
      {profile ? (
        <ProfilePanel key={profile} userId={profile} onClose={closePanel} />
      ) : chat && canRead && (
        <SidePanel title="Chat" subtitle={`#${ch.name}`} onClose={() => setChat(false)}>
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
