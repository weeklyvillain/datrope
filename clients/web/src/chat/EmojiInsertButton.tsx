import type { RefObject } from "react";
import { Smile } from "@/components/icons";
import { RefButton } from "@/components/ref-button";
import { EmojiPicker, emojiText } from "./EmojiPicker";
import type { RichInputHandle } from "./RichInput";

/** An emoji button for a RichInput field: inserts the picked emoji at the caret (custom emoji as `:name:`). */
export function EmojiInsertButton({ field, value, onChange, label = "Emoji" }: {
  field: RefObject<RichInputHandle>;
  value: string;
  /** Gets the new text; it may trim it to a length limit. */
  onChange: (value: string) => void;
  label?: string;
}) {
  return (
    <EmojiPicker
      onPick={(v) => {
        const { start, end } = field.current?.selection() ?? { start: value.length, end: value.length };
        const piece = emojiText(v);
        onChange(value.slice(0, start) + piece + value.slice(end));
        requestAnimationFrame(() => field.current?.setSelection(start + piece.length));
      }}
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        field.current?.focus();
      }}
      trigger={
        <RefButton variant="ghost" size="icon" className="flex-none text-muted-foreground" aria-label={label} title="Emoji"><Smile /></RefButton>
      } />
  );
}
