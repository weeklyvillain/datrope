import { X } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

/** Tag chips with remove buttons and an input that adds on Enter. */
export function TagsEditor({ value, onChange, max = 20, id }: { value: string[]; onChange: (v: string[]) => void; max?: number; id?: string }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const tag = draft.trim();
    if (!tag || value.length >= max || [...tag].length > 24) return;
    if (value.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
    setDraft("");
    onChange([...value, tag]);
  };
  return (
    <div className="grid gap-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((t) => (
            <li key={t}>
              <Badge variant="secondary" className="gap-1 pr-1">
                {t}
                <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}
                  className="grid size-4 place-items-center rounded-full outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50">
                  <X aria-hidden className="size-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <Input id={id} aria-label="Add a tag" placeholder="Add a tag" maxLength={48} value={draft} disabled={value.length >= max}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          add();
        }} />
    </div>
  );
}
