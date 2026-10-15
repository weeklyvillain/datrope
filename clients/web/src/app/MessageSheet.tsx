import type { ClientMessage } from "@datrope/core";
import { Copy, FileX, Images, Infinity as InfinityIcon, MessageSquare, MessageSquarePlus, Pencil, Pin, PinOff, Reply, SmilePlus, Timer, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ActionSheet, ActionSheetItem } from "@/components/action-sheet";
import { quickReactions } from "@/chat/recent-emoji";
import { useAlbumLabel } from "./gallery/AddToAlbum";
import { addAll, useAlbumsForFile } from "./gallery/albums";
import type { MessageAction } from "./message-actions";
import { BareButton } from "@/components/bare-button";

/** The phone's message menu: quick reactions on top, then the message's actions. */
export function MessageSheet({ open, onOpenChange, message, actions, hasThread, pinned, onReact, onMoreReactions, onReply, onThread, onEdit, onCopy, onPin, onAlbumError, onDelete, onKeepFiles, onRemoveFiles, preview }: {
  open: boolean; onOpenChange: (open: boolean) => void; message: ClientMessage; actions: MessageAction[];
  hasThread: boolean; pinned: boolean;
  onReact: (emoji: string) => void; onMoreReactions: () => void;
  onReply: () => void; onThread: () => void; onEdit: () => void; onCopy: () => void; onPin: () => void;
  onAlbumError: (message: string) => void; onDelete: () => void;
  onKeepFiles: (keep: boolean) => void; onRemoveFiles: () => void;
  preview: ReactNode;
}) {
  const [albums, setAlbums] = useState(false);
  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };
  return (
    <>
      <ActionSheet open={open} onOpenChange={onOpenChange} title="Message actions" header={preview}>
        {actions.includes("react") && (
          <div role="group" aria-label="Quick reactions" className="flex items-center justify-between gap-1 px-3 py-2">
            <QuickReactions onReact={(e) => run(() => onReact(e))()} />
            <BareButton aria-label="More reactions" onClick={run(onMoreReactions)}
              className="grid size-[44px] place-items-center rounded-full bg-secondary text-secondary-foreground hover:bg-accent focus-visible:bg-accent">
              <SmilePlus className="size-5" />
            </BareButton>
          </div>
        )}
        {actions.map((a) => {
          switch (a) {
            case "reply": return <ActionSheetItem key={a} icon={<Reply />} onSelect={run(onReply)}>Reply</ActionSheetItem>;
            case "thread": return (
              <ActionSheetItem key={a} icon={hasThread ? <MessageSquare /> : <MessageSquarePlus />} onSelect={run(onThread)}>
                {hasThread ? "Open thread" : "Start thread"}
              </ActionSheetItem>
            );
            case "edit": return <ActionSheetItem key={a} icon={<Pencil />} onSelect={run(onEdit)}>Edit message</ActionSheetItem>;
            case "copy": return <ActionSheetItem key={a} icon={<Copy />} onSelect={run(onCopy)}>Copy text</ActionSheetItem>;
            case "pin": return (
              <ActionSheetItem key={a} icon={pinned ? <PinOff /> : <Pin />} onSelect={run(onPin)}>
                {pinned ? "Unpin message" : "Pin message"}
              </ActionSheetItem>
            );
            case "album": return <ActionSheetItem key={a} icon={<Images />} onSelect={run(() => setAlbums(true))}>Add to album</ActionSheetItem>;
            case "keepFiles": return <ActionSheetItem key={a} icon={<InfinityIcon />} onSelect={run(() => onKeepFiles(true))}>Keep files forever</ActionSheetItem>;
            case "unkeepFiles": return <ActionSheetItem key={a} icon={<Timer />} onSelect={run(() => onKeepFiles(false))}>Let files expire</ActionSheetItem>;
            case "removeFiles": return <ActionSheetItem key={a} icon={<FileX />} destructive onSelect={run(onRemoveFiles)}>Remove files</ActionSheetItem>;
            case "delete": return <ActionSheetItem key={a} icon={<Trash2 />} destructive onSelect={run(onDelete)}>Delete message</ActionSheetItem>;
            default: return null;
          }
        })}
      </ActionSheet>
      {albums && (
        <AlbumSheet open={albums} onOpenChange={setAlbums} attachmentIds={(message.attachments ?? []).filter((x) => !x.expired).map((x) => x.id)}
          onError={onAlbumError} />
      )}
    </>
  );
}

/** Read from storage only while the sheet's content is mounted (open), not on every message row render. */
function QuickReactions({ onReact }: { onReact: (emoji: string) => void }) {
  return quickReactions().map((e) => (
    <BareButton key={e} aria-label={`React with ${e}`} onClick={() => onReact(e)}
      className="grid size-[44px] place-items-center rounded-full bg-secondary text-2xl leading-none hover:bg-accent focus-visible:bg-accent">
      {e}
    </BareButton>
  ));
}

function AlbumSheet({ open, onOpenChange, attachmentIds, onError }: {
  open: boolean; onOpenChange: (open: boolean) => void; attachmentIds: string[]; onError: (message: string) => void;
}) {
  const { albums } = useAlbumsForFile(attachmentIds[0]);
  const label = useAlbumLabel();
  const close = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };
  return (
    <ActionSheet open={open} onOpenChange={onOpenChange} title="Add to album">
      {albums.map((a) => (
        <ActionSheetItem key={a.id} icon={<Images />} onSelect={close(() => void addAll(a.id, attachmentIds).then((m) => m && onError(m)))}>
          {label(a)}
        </ActionSheetItem>
      ))}
    </ActionSheet>
  );
}
