import { MessageSquare, MessageSquarePlus, Pencil, Pin, PinOff, Reply, SmilePlus, Trash2 } from "lucide-react";
import { forwardRef, useState, type ComponentProps, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { RefButton } from "@/components/ref-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { EmojiPicker, reactionKey } from "@/chat/EmojiPicker";

/** The floating actions at the top right of a message row, shown on hover and focus. */
export function MessageToolbar({ onReact, onReply, onThread, hasThread, onEdit, onPin, pinned, onDelete }: {
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
  onDelete?: () => void;
}) {
  // The toolbar stays while its picker is open, so the picker keeps its anchor, and until
  // focus is back on its trigger (which then keeps it shown through focus-within).
  const [picking, setPicking] = useState(false);
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
    </div>
  );
}

/** The "Add reaction" button; it forwards the picker trigger's ref and props through the tooltip. */
const ReactAction = forwardRef<HTMLButtonElement, ComponentProps<"button">>((props, ref) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <RefButton ref={ref} {...props} variant="ghost" size="icon-sm" aria-label="Add reaction" className="text-muted-foreground">
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
