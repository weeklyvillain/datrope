import { useEditorState, type Editor } from "@tiptap/react";
import {
  Bold, Code, Heading1, Heading2, Italic, Link as LinkIcon, List, ListChecks, ListOrdered, Quote, SquareCode, Strikethrough, type LucideIcon,
} from "lucide-react";
import { useState, type MouseEvent } from "react";
import { Toolbar } from "radix-ui";
import { RefToggle } from "@/components/ref-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Toolbar buttons keep the caret in the editor: no blur (and no save flush) between press and format. */
const keepFocus = (e: MouseEvent) => e.preventDefault();

type Mark = { label: string; icon: LucideIcon; active: (e: Editor) => boolean; run: (e: Editor) => void };

const MARKS: Mark[] = [
  { label: "Bold", icon: Bold, active: (e) => e.isActive("bold"), run: (e) => e.chain().focus().toggleBold().run() },
  { label: "Italic", icon: Italic, active: (e) => e.isActive("italic"), run: (e) => e.chain().focus().toggleItalic().run() },
  { label: "Strikethrough", icon: Strikethrough, active: (e) => e.isActive("strike"), run: (e) => e.chain().focus().toggleStrike().run() },
  { label: "Heading 1", icon: Heading1, active: (e) => e.isActive("heading", { level: 1 }), run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { label: "Heading 2", icon: Heading2, active: (e) => e.isActive("heading", { level: 2 }), run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { label: "Bulleted list", icon: List, active: (e) => e.isActive("bulletList"), run: (e) => e.chain().focus().toggleBulletList().run() },
  { label: "Numbered list", icon: ListOrdered, active: (e) => e.isActive("orderedList"), run: (e) => e.chain().focus().toggleOrderedList().run() },
  { label: "Checklist", icon: ListChecks, active: (e) => e.isActive("taskList"), run: (e) => e.chain().focus().toggleTaskList().run() },
  { label: "Quote", icon: Quote, active: (e) => e.isActive("blockquote"), run: (e) => e.chain().focus().toggleBlockquote().run() },
  { label: "Inline code", icon: Code, active: (e) => e.isActive("code"), run: (e) => e.chain().focus().toggleCode().run() },
  { label: "Code block", icon: SquareCode, active: (e) => e.isActive("codeBlock"), run: (e) => e.chain().focus().toggleCodeBlock().run() },
];

/** Formatting buttons: one tab stop, arrow keys move between them (Radix Toolbar); scrolls sideways when narrow. */
export function NoteToolbar({ editor }: { editor: Editor }) {
  const active = useEditorState({ editor, selector: ({ editor: e }) => [...MARKS.map((m) => m.active(e)), e.isActive("link")].join() })
    .split(",").map((v) => v === "true");
  return (
    <Toolbar.Root aria-label="Formatting" loop className="flex flex-none items-center gap-0.5 overflow-x-auto border-b px-3 py-1.5">
      {MARKS.map((m, i) => (
        <Tooltip key={m.label}>
          <TooltipTrigger asChild>
            <Toolbar.Button asChild>
              <RefToggle size="sm" aria-label={m.label} pressed={active[i]} onPressedChange={() => m.run(editor)} onMouseDown={keepFocus}>
                <m.icon />
              </RefToggle>
            </Toolbar.Button>
          </TooltipTrigger>
          <TooltipContent>{m.label}</TooltipContent>
        </Tooltip>
      ))}
      <LinkButton editor={editor} active={active[MARKS.length]} />
    </Toolbar.Root>
  );
}

function LinkButton({ editor, active }: { editor: Editor; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const apply = () => {
    const href = url.trim();
    if (href) editor.chain().focus().extendMarkRange("link").setLink({ href: /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : `https://${href}` }).run();
    setOpen(false);
  };
  const remove = () => {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setUrl(editor.getAttributes("link").href ?? ""); }}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Toolbar.Button asChild>
              <RefToggle size="sm" aria-label="Link" pressed={active}><LinkIcon /></RefToggle>
            </Toolbar.Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Link</TooltipContent>
      </Tooltip>
      <PopoverContent className="flex w-80 gap-2">
        <Input aria-label="Link address" placeholder="https://" value={url} autoFocus
          onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } }} />
        {active && <Button variant="ghost" size="sm" onClick={remove}>Remove</Button>}
        <Button size="sm" onClick={apply}>Apply</Button>
      </PopoverContent>
    </Popover>
  );
}
