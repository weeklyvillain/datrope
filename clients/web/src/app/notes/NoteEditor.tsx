import type { Note } from "@datrope/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef } from "react";
import type { Patch } from "./autosave";
import { shouldReload } from "./notes-model";
import { NoteToolbar } from "./NoteToolbar";

const EXTENSIONS = [
  StarterKit.configure({
    heading: { levels: [1, 2] },
    link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } },
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Placeholder.configure({ placeholder: "Write something…" }),
];

/** Shows the stored copy when it differs and nothing local could be lost. */
function takeStored(editor: Editor, { note, dirty }: { note: Note; dirty: boolean }) {
  if (!shouldReload({ current: editor.getJSON(), incoming: note.content, dirty, focused: editor.isFocused })) return;
  editor.commands.setContent(note.content, { emitUpdate: false });
}

/** The note's body. A newer copy from another device replaces the text only while this one has no unsaved edits and isn't focused. */
export function NoteEditor({ note, dirty, onEdit, onBlur }: { note: Note; dirty: boolean; onEdit: (p: Patch) => void; onBlur: () => void }) {
  const handlers = useRef({ onEdit, onBlur });
  handlers.current = { onEdit, onBlur };
  const latest = useRef({ note, dirty });
  latest.current = { note, dirty };
  const editor = useEditor({
    extensions: EXTENSIONS,
    content: note.content,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { "aria-label": "Note", "aria-multiline": "true", role: "textbox", class: "note-editor" } },
    onUpdate: ({ editor: e }) => handlers.current.onEdit({ content: e.getJSON() as Record<string, unknown>, text: e.getText() }),
    onBlur: ({ editor: e }) => {
      handlers.current.onBlur();
      takeStored(e, latest.current); // a newer copy that arrived while focused
    },
  }, [note.id]);

  useEffect(() => {
    if (editor) takeStored(editor, latest.current);
  }, [editor, note.updated_at]);

  if (!editor) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <NoteToolbar editor={editor} />
      <div className="min-h-0 flex-1 cursor-text overflow-y-auto overscroll-y-contain" onClick={(e) => { if (e.target === e.currentTarget) editor.commands.focus("end"); }}>
        <EditorContent editor={editor} className="mx-auto w-full max-w-[720px] px-6 py-6 md:px-10" />
      </div>
    </div>
  );
}
