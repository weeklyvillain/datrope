import { AlarmClock, Copy, Ellipsis, Images, MessageSquare, MessageSquarePlus, Pencil, Pin, PinOff, Reply, SmilePlus, Trash2 } from "lucide-react";
import { forwardRef, useState, type ComponentProps, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { RefButton } from "@/components/ref-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { EmojiPicker, reactionKey } from "@/chat/EmojiPicker";

/** The floating actions at the top right of a message row, shown on hover and focus. */
export function MessageToolbar({ onReact, onReply, onThread, hasThread, onEdit, onPin, pinned, onCopy, albumItems, remindItems, onDelete }: {
  /** Adds a reaction (a Unicode emoji or `custom:<id>`) picked from the emoji picker. */
  onReact?: (emoji: string) => void;
  onReply?: () => void;
  /** Opens the message's thread (`hasThread`) or creates one. */
  onThread?: () => void;
  hasThread?: boolean;
  onEdit?: () => void;
  /** Pins or unpins the message; `pinned` says which. */
  onPin?: () => void;
  pinned?: boolean;
  /** Copies the message text. */
  onCopy?: () => void;
  /** The "Add to album" submenu's items. */
  albumItems?: ReactNode;
  /** The "Remind me" submenu's items. */
  remindItems?: ReactNode;
  onDelete?: () => void;
}) {
  // The toolbar stays while its picker is open, so the picker keeps its anchor, and until
  // focus is back on its trigger (which then keeps it shown through focus-within).
  const [picking, setPicking] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const openMenu = (o: boolean) => { setMenuOpen(o); if (o) setPicking(true); };
  const hasMenu = !!(onReply || onThread || onEdit || onPin || onCopy || albumItems || remindItems || onDelete);
  return (
    <div className={cn("absolute -top-4 right-4 z-10 rounded-md border bg-popover p-0.5 shadow-sm group-hover:flex group-focus-within:flex",
      picking ? "flex" : "hidden")}>
      {onReact && <EmojiPicker onOpenChange={(open) => open && setPicking(true)} onCloseAutoFocus={() => setPicking(false)}
        onPick={(v) => onReact(reactionKey(v))} trigger={<ReactAction />} />}
      {onReply && <Action label="Reply" tip="Reply" onClick={onReply}><Reply /></Action>}
      {onThread && (hasThread
        ? <Action label="Open thread" tip="Open thread" onClick={onThread}><MessageSquare /></Action>
        : <Action label="Create thread" tip="Create thread" onClick={onThread}><MessageSquarePlus /></Action>)}
      {onEdit && <Action label="Edit message" tip="Edit" onClick={onEdit}><Pencil /></Action>}
      {onPin && (pinned
        ? <Action label="Unpin message" tip="Unpin" onClick={onPin}><PinOff /></Action>
        : <Action label="Pin message" tip="Pin" onClick={onPin}><Pin /></Action>)}
      {onDelete && <Action label="Delete message" tip="Delete" onClick={onDelete} destructive><Trash2 /></Action>}
      {hasMenu && <DropdownMenu modal={false} open={menuOpen} onOpenChange={openMenu}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <RefButton data-message-menu onClick={(e) => { if (e.detail === 0) openMenu(true); }} variant="ghost" size="icon-sm" aria-label="More actions" className="text-muted-foreground"><Ellipsis /></RefButton>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>More</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-52" onContextMenu={(e) => e.stopPropagation()}
          onCloseAutoFocus={(e) => {
            setPicking(false);
            // Keep focus where an item sent it (the composer, a dialog).
            if (document.activeElement && document.activeElement !== document.body) e.preventDefault();
          }}>
          {onReply && <DropdownMenuItem onSelect={onReply}><Reply />Reply</DropdownMenuItem>}
          {onThread && <DropdownMenuItem onSelect={onThread}>{hasThread ? <><MessageSquare />Open thread</> : <><MessageSquarePlus />Create thread</>}</DropdownMenuItem>}
          {onEdit && <DropdownMenuItem onSelect={onEdit}><Pencil />Edit message</DropdownMenuItem>}
          {onPin && <DropdownMenuItem onSelect={onPin}>{pinned ? <><PinOff />Unpin message</> : <><Pin />Pin message</>}</DropdownMenuItem>}
          {onCopy && <DropdownMenuItem onSelect={onCopy}><Copy />Copy text</DropdownMenuItem>}
          {remindItems && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><AlarmClock />Remind me</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-60">{remindItems}</DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {albumItems && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><Images />Add to album</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-56">{albumItems}</DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {onDelete && <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onSelect={onDelete}><Trash2 />Delete message</DropdownMenuItem></>}
        </DropdownMenuContent>
      </DropdownMenu>}
    </div>
  );
}

/** The "Add reaction" button; it forwards the picker trigger's ref and props through the tooltip. */
const ReactAction = forwardRef<HTMLButtonElement, ComponentProps<"button">>((props, ref) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <RefButton ref={ref} {...props} data-message-react variant="ghost" size="icon-sm" aria-label="Add reaction" className="text-muted-foreground">
        <SmilePlus />
      </RefButton>
    </TooltipTrigger>
    <TooltipContent>Add reaction</TooltipContent>
  </Tooltip>
));
ReactAction.displayName = "ReactAction";

function Action({ label, tip, onClick, destructive, children }:
  { label: string; tip: string; onClick: () => void; destructive?: boolean; children: ReactNode }) {
  // The span takes the trigger's ref: Button doesn't forward refs (React 18).
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex">
          <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}
            className={destructive ? "text-destructive hover:text-destructive" : "text-muted-foreground"}>
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}
