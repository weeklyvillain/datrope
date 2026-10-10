import { Smile } from "lucide-react";
import { RefButton } from "@/components/ref-button";
import { EmojiPicker, emojiText } from "./EmojiPicker";

/** An emoji button for a text field: inserts the picked emoji at the caret (custom emoji as `:name:`). */
export function EmojiInsertButton({ fieldId, value, onChange, label = "Emoji" }: {
  /** The id of the input or textarea (shadcn's Input and Textarea take no ref in React 18). */
  fieldId: string;
  value: string;
  /** Gets the new text; it may trim it to a length limit. */
  onChange: (value: string) => void;
  label?: string;
}) {
  const field = () => document.getElementById(fieldId) as HTMLInputElement | HTMLTextAreaElement | null;
  return (
    <EmojiPicker
      onPick={(v) => {
        const el = field();
        const start = el?.selectionStart ?? value.length;
        const end = el?.selectionEnd ?? value.length;
        const piece = emojiText(v);
        onChange(value.slice(0, start) + piece + value.slice(end));
        requestAnimationFrame(() => field()?.setSelectionRange(start + piece.length, start + piece.length));
      }}
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        field()?.focus();
      }}
      trigger={
        <RefButton variant="ghost" size="icon" className="flex-none text-muted-foreground" aria-label={label} title="Emoji"><Smile /></RefButton>
      } />
  );
}
