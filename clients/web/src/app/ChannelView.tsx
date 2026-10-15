import { Perm, canPost, hasPerm, myThreadPerms, voiceMembers, type ReplyRef } from "@datrope/core";
import { Lock, LogOut, Megaphone, MessageSquare, Phone, Pin, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { dmName, useApp, usePerms, userName } from "../session";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChannelFeed } from "@/hooks/use-channel-feed";
import { useIsMobile } from "@/hooks/use-mobile";
import { useLayoutTier } from "@/hooks/use-layout-tier";
import { readMembersPref, writeMembersPref } from "@/lib/members-pref";
import { useHistoryLayer } from "@/hooks/use-history-layer";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Markdown } from "../chat/Markdown";
import { ChannelSettingsDialog } from "./dialogs/ChannelSettingsDialog";
import { LeaveGroupDialog } from "./dialogs/LeaveGroupDialog";
import { useVoice, voice } from "../voice/voice";
import { Composer } from "./Composer";
import { onToggleMembers } from "./chat-events";
import { MemberList, MembersSheetBand } from "./MemberList";
import { useChrome } from "./desktop-chrome";
import { MessageList, jumpTo } from "./MessageList";
import { PinsPanel, PinsSheet } from "./PinsPanel";
import { SearchPanel } from "./search/SearchPanel";
import { closePanel, openPanel, panelStore, usePanel } from "./side-panel/panel";
import { ThreadPanel } from "./side-panel/ThreadPanel";
import { SidePanel } from "./side-panel/SidePanel";
import { ThreadsList } from "./side-panel/ThreadsList";
import { TopBar, type PhoneAction } from "./TopBar";
import { ChannelInfoSheet } from "./mobile/ChannelInfoSheet";
import { EmojiText } from "@/chat/EmojiText";
import { NoAccess } from "../pages/errors";
import { VoiceStage } from "./voice/VoiceStage";
import { BareButton } from "@/components/bare-button";

/** A text channel or DM. `members` shows the member list beside it (hidden while a side panel is open).
 *  `kind="announcement"` shows posts as titled cards, with a composer only for those who may post. */
export function ChannelView({ channelId, members = false, kind = "chat" }: { channelId: string; members?: boolean; kind?: "chat" | "announcement" }) {
  const ch = useApp((s) => s.channels[channelId]);
  const me = useApp((s) => s.me);
  const perms = usePerms(channelId);
  const threadPerms = useApp((s) => myThreadPerms(s, channelId));
  const inCall = useApp((s) => voiceMembers(s, channelId).length);
  const here = useVoice((v) => v.channelId === channelId && v.status !== "idle");
  const loadError = useChannelFeed(channelId);
  const panel = usePanel((s) => s.panel);
  const [replyTo, setReplyTo] = useState<ReplyRef | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [showMembers, setShowMembers] = useState(false); // phones: the member list as a sheet
  useHistoryLayer("members", showMembers, () => setShowMembers(false));
  const mobile = useIsMobile();
  const banded = useChrome((s) => s.claimed);
  const tier = useLayoutTier();
  const docked = tier === "wide";
  const [membersDocked, setMembersDocked] = useState(readMembersPref);
  const toggleMembers = useCallback(() => {
    if (!docked) return setShowMembers(true); // narrow and medium: the member list slides over
    setMembersDocked((v) => { writeMembersPref(!v); return !v; });
  }, [docked]);
  useEffect(() => onToggleMembers(toggleMembers), [toggleMembers]);
  useEffect(() => { if (docked) setShowMembers(false); }, [docked]);
  const [info, setInfo] = useState(false); // phones: the channel info sheet
  const [pins, setPins] = useState(false); // phones: the pinned messages sheet
  const [settings, setSettings] = useState(false); // phones: channel settings, from the info sheet
  const reply = useMemo(() => ({ replyTo, setReplyTo }), [replyTo]);

  // A reply and the side panel belong to their channel.
  useEffect(() => {
    setReplyTo(null);
    // A thread, a forum post, a gallery item or the threads list belongs to its channel; a profile (and search) stays open.
    // A thread opened from a search result is opened along with its parent channel, so it stays.
    const p = panelStore.getState().panel;
    if (p?.kind === "threads" || p?.kind === "post" || p?.kind === "media" || (p?.kind === "thread" && p.parentId !== channelId)) closePanel();
  }, [channelId]);

  if (!ch) return <NoAccess inShell />;
  const title = ch.type === "dm" ? dmName(ch, me?.id) : `# ${ch.name}`;
  // Threads live in text, webhook, announcement and gallery channels (never in DMs, threads or voice side chats).
  const threads = ch.type === "text" || ch.type === "webhook" || ch.type === "announcement" || ch.type === "gallery";
  // Starting one needs SEND_MESSAGES in the thread, which a webhook channel's mask does not take away.
  const canCreateThread = threads && hasPerm(perms, Perm.CreateThreads) && hasPerm(threadPerms, Perm.SendMessages);
  const openThread = (threadId: string) => openPanel({ kind: "thread", threadId });
  const jumpToPin = (id: string) => void jumpTo(channelId, id).catch(() => undefined);
  const phoneActions: PhoneAction[] = [
    ...(threads ? [{ label: "Threads", icon: <MessageSquare />, onSelect: () => (panel?.kind === "threads" ? closePanel() : openPanel({ kind: "threads" })) }] : []),
    { label: "Pinned messages", icon: <Pin />, onSelect: () => setPins(true) },
    ...(members ? [{ label: "Members", icon: <Users />, onSelect: () => setShowMembers(true) }] : []),
    ...(ch.type === "dm" && !here && inCall === 0 ? [{ label: "Start call", icon: <Phone />, onSelect: () => void voice.join(channelId) }] : []),
    ...(ch.group ? [{ label: "Leave group", icon: <LogOut />, destructive: true, onSelect: () => setLeaving(true) }] : []),
  ];
  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col bg-background" aria-label={title}>
        <TopBar phoneActions={phoneActions} onTitleClick={() => setInfo(true)} actions={(
          <>
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
            <PinsPanel channelId={channelId} onJump={jumpToPin} />
            {members && !mobile && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex">
                    <Button variant="ghost" size="icon-sm" aria-label="Members" aria-pressed={docked ? membersDocked && !panel : showMembers}
                      className={(docked ? membersDocked && !panel : showMembers) ? "text-foreground" : "text-muted-foreground"}
                      onClick={toggleMembers}>
                      <Users />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{docked && membersDocked ? "Hide members" : "Show members"}</TooltipContent>
              </Tooltip>
            )}
            {ch.type === "dm" && !here && inCall === 0 && (
              <Button variant="outline" size="sm" className="max-md:px-2" onClick={() => void voice.join(channelId)}><Phone /><span className="max-md:sr-only">Start call</span></Button>
            )}
            {ch.group && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex">
                    <Button variant="ghost" size="icon-sm" aria-label="Leave group" className="text-muted-foreground" onClick={() => setLeaving(true)}>
                      <LogOut />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Leave group</TooltipContent>
              </Tooltip>
            )}
          </>
        )}>
          {kind === "announcement" && <Megaphone className="size-5 flex-none text-muted-foreground" aria-hidden />}
          <h1 className="flex-none">{ch.type === "dm" ? title : <># <EmojiText text={ch.name} /></>}</h1>
          {!mobile && ch.type !== "dm" && ch.topic && <Topic channelId={channelId} name={ch.name} topic={ch.topic} canEdit={hasPerm(perms, Perm.ManageChannels)} />}
        </TopBar>
        {ch.type === "dm" && (inCall > 0 || here) && (
          <div className="border-b"><VoiceStage channelId={channelId} joinLabel="Join call" compact /></div>
        )}
        {loadError ? <ErrorText error={loadError} /> : <MessageList channelId={channelId} canManage={hasPerm(perms, Perm.ManageMessages)}
          canReply={hasPerm(perms, Perm.SendMessages)} canReact={hasPerm(perms, Perm.AddReactions)} reply={reply}
          canCreateThread={canCreateThread} onOpenThread={threads ? openThread : undefined}
          variant={kind === "announcement" ? "cards" : "chat"}
          emptyTitle={ch.type === "dm" ? "This is the start of your conversation" : `This is the start of #${ch.name}`} />}
        <TypingLine channelId={channelId} />
        {kind === "announcement" && !canPost(ch, perms) ? (
          <p role="note" className="mx-auto mb-4 flex w-[calc(100%-2rem)] max-w-3xl items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground">
            <Lock className="size-4 flex-none" aria-hidden />
            Only members with Manage messages can post here. React to a post or reply in its thread.
          </p>
        ) : (
          <div className={kind === "announcement" ? "mx-auto w-full max-w-3xl" : undefined}>
            <Composer channelId={channelId} canSend={canPost(ch, perms)} canAttach={hasPerm(perms, Perm.AttachFiles)}
              placeholder={kind === "announcement" ? "Write an announcement" : ch.type === "dm" ? `Message ${dmName(ch, me?.id)}` : `Message #${ch.name}`}
              reply={reply} withTitle={kind === "announcement"}
              readOnlyText={ch.type === "webhook" ? "Only webhooks can post in this channel." : undefined} />
          </div>
        )}
        {(mobile || tier === "narrow") && <PinsSheet channelId={channelId} open={pins} onOpenChange={setPins} onJump={jumpToPin} />}
        {mobile && (
          <>
            <ChannelInfoSheet channelId={channelId} kind={kind} open={info} onOpenChange={setInfo}
              onPins={() => setPins(true)} onMembers={members ? () => setShowMembers(true) : undefined}
              onThreads={threads ? () => openPanel({ kind: "threads" }) : undefined}
              onSettings={ch.type !== "dm" && hasPerm(perms, Perm.ManageChannels) ? () => setSettings(true) : undefined} />
            {settings && <ChannelSettingsDialog channelId={channelId} onClose={() => setSettings(false)} />}
          </>
        )}
        {leaving && <LeaveGroupDialog channelId={channelId} onClose={() => setLeaving(false)} />}
      </main>
      {panel?.kind === "threads" ? (
        <SidePanel title="Threads" subtitle={`in #${ch.name}`} onClose={closePanel}>
          <ThreadsList channelId={channelId} onOpen={openThread} />
        </SidePanel>
      ) : panel?.kind === "thread" ? (
        <ThreadPanel key={panel.threadId} threadId={panel.threadId} parentChannelId={channelId} onClose={closePanel} />
      ) : panel?.kind === "search" ? (
        <SearchPanel />
      ) : members && docked && membersDocked && <MemberList channelId={channelId} />}
      {members && (
        <Sheet open={showMembers} onOpenChange={setShowMembers}>
          <SheetContent side="right" showCloseButton={!banded} className="w-[85vw] max-w-80 gap-0 p-0 sm:max-w-80 md:w-[280px]"
            onCloseAutoFocus={(e) => { // back to the opener: the Members button, or the more-actions menu button in the narrow tier
              e.preventDefault();
              document.querySelector<HTMLElement>('header button[aria-label="Members"], header button[aria-label="More actions"]')?.focus();
            }}>
            {banded ? <MembersSheetBand /> : <SheetTitle className="sr-only">Members</SheetTitle>}
            <SheetDescription className="sr-only">Who can see this channel</SheetDescription>
            <MemberList sheet channelId={channelId} />
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}

/** The channel topic, one truncated line; click shows all of it. */
export function Topic({ channelId, name, topic, canEdit }: { channelId: string; name: string; topic: string; canEdit: boolean }) {
  const [open, setOpen] = useState<"topic" | "settings">();
  return (
    <>
      <span className="h-5 w-px flex-none bg-border max-md:hidden" aria-hidden />
      <BareButton className="min-w-0 flex-1 truncate text-left max-md:hidden text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
        title="Show topic" onClick={() => setOpen("topic")}>
        <Markdown text={topic} inline />
      </BareButton>
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
