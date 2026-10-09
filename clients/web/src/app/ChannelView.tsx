import { Perm, hasPerm, voiceMembers, type ReplyRef } from "@datrope/core";
import { MessageSquare, Phone } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { dmName, useApp, usePerms, userName } from "../session";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChannelFeed } from "@/hooks/use-channel-feed";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Markdown } from "../chat/Markdown";
import { ChannelSettingsDialog } from "./dialogs/ChannelSettingsDialog";
import { useVoice, voice } from "../voice/voice";
import { Composer } from "./Composer";
import { MemberList } from "./MemberList";
import { MessageList, jumpTo } from "./MessageList";
import { PinsPanel } from "./PinsPanel";
import { ProfilePanel } from "./people/ProfilePanel";
import { closePanel, openPanel, panelStore, usePanel } from "./side-panel/panel";
import { ThreadPanel } from "./side-panel/ThreadPanel";
import { SidePanel } from "./side-panel/SidePanel";
import { ThreadsList } from "./side-panel/ThreadsList";
import { VoiceStage } from "./voice/VoiceStage";

/** A text channel or DM. `members` shows the member list beside it (hidden while a side panel is open). */
export function ChannelView({ channelId, members = false }: { channelId: string; members?: boolean }) {
  const ch = useApp((s) => s.channels[channelId]);
  const me = useApp((s) => s.me);
  const perms = usePerms(channelId);
  const inCall = useApp((s) => voiceMembers(s, channelId).length);
  const here = useVoice((v) => v.channelId === channelId && v.status !== "idle");
  const loadError = useChannelFeed(channelId);
  const panel = usePanel((s) => s.panel);
  const [replyTo, setReplyTo] = useState<ReplyRef | null>(null);
  const reply = useMemo(() => ({ replyTo, setReplyTo }), [replyTo]);

  // A reply and the side panel belong to their channel.
  useEffect(() => {
    setReplyTo(null);
    // A thread or the threads list belongs to its channel; a profile (and search) stays open.
    const kind = panelStore.getState().panel?.kind;
    if (kind === "thread" || kind === "threads") closePanel();
  }, [channelId]);

  if (!ch) return <main className="grid min-h-full min-w-0 flex-1 place-items-center bg-background p-8 text-center text-muted-foreground">This channel is not available.</main>;
  const title = ch.type === "dm" ? dmName(ch, me?.id) : `# ${ch.name}`;
  // Threads live in text channels only (never in DMs, threads or voice side chats).
  const threads = ch.type === "text";
  const canCreateThread = threads && hasPerm(perms, Perm.CreateThreads) && hasPerm(perms, Perm.SendMessages);
  const openThread = (threadId: string) => openPanel({ kind: "thread", threadId });
  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col bg-background" aria-label={title}>
        <header className="flex h-14 flex-none items-center justify-between gap-2 border-b bg-card px-4">
          <h2 className="flex-none">{title}</h2>
          {ch.type !== "dm" && ch.topic && <Topic channelId={channelId} name={ch.name} topic={ch.topic} canEdit={hasPerm(perms, Perm.ManageChannels)} />}
          <div className="ml-auto flex flex-none items-center gap-1">
            {threads && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex">
                    <Button variant="ghost" size="icon-sm" aria-label="Threads" aria-pressed={panel?.kind === "threads"}
                      className={panel?.kind === "threads" ? "text-foreground" : "text-muted-foreground"}
                      onClick={() => (panel?.kind === "threads" ? closePanel() : openPanel({ kind: "threads" }))}>
                      <MessageSquare />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Threads</TooltipContent>
              </Tooltip>
            )}
            <PinsPanel channelId={channelId} onJump={(id) => void jumpTo(channelId, id)} />
          </div>
          {ch.type === "dm" && !here && inCall === 0 && (
            <Button variant="outline" size="sm" onClick={() => void voice.join(channelId)}><Phone /> Start call</Button>
          )}
        </header>
        {ch.type === "dm" && (inCall > 0 || here) && (
          <div className="border-b"><VoiceStage channelId={channelId} joinLabel="Join call" compact /></div>
        )}
        {loadError ? <ErrorText error={loadError} /> : <MessageList channelId={channelId} canManage={hasPerm(perms, Perm.ManageMessages)}
          canReply={hasPerm(perms, Perm.SendMessages)} canReact={hasPerm(perms, Perm.AddReactions)} reply={reply}
          canCreateThread={canCreateThread} onOpenThread={threads ? openThread : undefined} />}
        <TypingLine channelId={channelId} />
        <Composer channelId={channelId} canSend={hasPerm(perms, Perm.SendMessages)} canAttach={hasPerm(perms, Perm.AttachFiles)}
          placeholder={ch.type === "dm" ? `Message ${dmName(ch, me?.id)}` : `Message #${ch.name}`} reply={reply} />
      </main>
      {panel?.kind === "threads" ? (
        <SidePanel title="Threads" subtitle={`in #${ch.name}`} onClose={closePanel}>
          <ThreadsList channelId={channelId} onOpen={openThread} />
        </SidePanel>
      ) : panel?.kind === "thread" ? (
        <ThreadPanel key={panel.threadId} threadId={panel.threadId} parentChannelId={channelId} onClose={closePanel} />
      ) : panel?.kind === "profile" ? (
        <ProfilePanel key={panel.userId} userId={panel.userId} onClose={closePanel} />
      ) : members && <MemberList />}
    </>
  );
}

/** The channel topic, one truncated line; click shows all of it. */
export function Topic({ channelId, name, topic, canEdit }: { channelId: string; name: string; topic: string; canEdit: boolean }) {
  const [open, setOpen] = useState<"topic" | "settings">();
  return (
    <>
      <span className="h-5 w-px flex-none bg-border" aria-hidden />
      <button type="button" className="min-w-0 flex-1 truncate text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
        title="Show topic" onClick={() => setOpen("topic")}>
        <Markdown text={topic} inline />
      </button>
      {open === "topic" && (
        <Dialog open onOpenChange={(o) => !o && setOpen(undefined)}>
          <DialogContent aria-describedby={undefined} className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]">
            <DialogHeader>
              <DialogTitle>{`# ${name}`}</DialogTitle>
            </DialogHeader>
            <div className="break-words"><Markdown text={topic} /></div>
            {canEdit && (
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen("settings")}>Edit</Button>
              </DialogFooter>
            )}
          </DialogContent>
        </Dialog>
      )}
      {open === "settings" && <ChannelSettingsDialog channelId={channelId} onClose={() => setOpen(undefined)} />}
    </>
  );
}

function TypingLine({ channelId }: { channelId: string }) {
  const names = useApp(useShallow((s) => Object.keys(s.typing[channelId] ?? {}).map((id) => userName(s, id))));
  return (
    <div className="min-h-[1.4rem] px-4 text-sm text-muted-foreground" aria-live="polite">
      {names.length > 0 ? `${names.join(", ")} ${names.length === 1 ? "is" : "are"} typing…` : " "}
    </div>
  );
}
