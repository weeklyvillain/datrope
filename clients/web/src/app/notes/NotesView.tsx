import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLayerNavigate } from "@/hooks/use-history-layer";
import { useIsMobile } from "@/hooks/use-mobile";
import { EmptyView } from "../EmptyView";
import { ScreenHeader } from "../mobile/ScreenHeader";
import { timeAgo } from "../threads";
import { TopBar } from "../TopBar";
import { errorText } from "../../session";
import { useAutosave, type SaveStatus } from "./autosave";
import { NoteEditor } from "./NoteEditor";
import { NoteMenu } from "./NoteMenu";
import { NotesPane } from "./NotesPane";
import { shownTitle } from "./notes-model";
import { openNote, useNotes } from "./notes-store";

/** /notes and /notes/:noteId. Desktop: the list is in the sidebar's Notes tab. Phones: list and note are pushed screens. */
export function NotesView() {
  const { noteId } = useParams();
  const mobile = useIsMobile();
  if (!noteId) {
    return mobile ? (
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label="Notes">
        <ScreenHeader title="Notes" />
        <NotesPane className="pb-safe" />
      </main>
    ) : <EmptyView title="Notes">Select a note or create a new one.</EmptyView>;
  }
  return <OpenNote key={noteId} noteId={noteId} />;
}

function OpenNote({ noteId }: { noteId: string }) {
  const mobile = useIsMobile();
  const nav = useLayerNavigate();
  const focusTitle = !!(useLocation().state as { focusTitle?: boolean } | null)?.focusTitle;
  const note = useNotes((s) => s.notes[noteId]);
  const missing = useNotes((s) => !!s.missing[noteId]);
  const dirty = useNotes((s) => !!s.dirty[noteId]);
  const { status, edit, flush, retry } = useAutosave();
  const [title, setTitle] = useState<string>();
  const [editingTitle, setEditingTitle] = useState(false);
  const [error, setError] = useState("");
  const seen = useRef(false);
  if (note) seen.current = true;

  useEffect(() => {
    openNote(noteId).catch((e: unknown) => setError(errorText(e)));
  }, [noteId]);
  // Deleted here or on another device while open: back to the list.
  useEffect(() => {
    if (missing && seen.current) nav("/notes", { replace: true });
  }, [missing, nav]);

  if (missing) {
    return <EmptyView title="Notes">This note doesn't exist. <Link to="/notes">Back to notes</Link></EmptyView>;
  }
  if (error) return <EmptyView title="Notes"><span role="alert">{error}</span></EmptyView>;
  if (!note) return <main className="flex-1 bg-background" aria-busy="true" />;

  const titleInput = (
    <Input aria-label="Title" placeholder="Untitled" maxLength={100} value={shownTitle({ local: title, stored: note.title, editing: editingTitle })} autoFocus={focusTitle}
      onFocus={() => { setTitle(note.title); setEditingTitle(true); }}
      onChange={(e) => { setTitle(e.target.value); edit(note.id, { title: e.target.value }); }}
      onBlur={() => { setEditingTitle(false); void flush(); }}
      className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-1.5 text-title font-semibold shadow-none hover:border-border focus-visible:ring-1" />
  );
  const actions = (
    <>
      <SaveState status={status} updatedAt={note.updated_at} onRetry={() => void retry()} />
      <NoteMenu noteId={note.id} onDeleted={() => nav("/notes", { replace: true })} />
    </>
  );
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label="Note">
      {mobile ? <ScreenHeader title={titleInput} actions={actions} /> : <TopBar tools={false} actions={actions}>{titleInput}</TopBar>}
      <NoteEditor note={note} dirty={dirty} onEdit={(p) => edit(note.id, p)} onBlur={() => void flush()} />
    </main>
  );
}

function SaveState({ status, updatedAt, onRetry }: { status: SaveStatus; updatedAt: string; onRetry: () => void }) {
  if (status === "error") {
    return (
      <span className="flex items-center gap-1 text-meta text-destructive" role="status">
        Couldn't save<Button variant="ghost" size="sm" onClick={onRetry}>Retry</Button>
      </span>
    );
  }
  const text = status === "saving" ? "Saving…" : status === "saved" ? "Saved" : `Edited ${timeAgo(updatedAt)}`;
  return <span className="whitespace-nowrap text-meta text-muted-foreground max-md:sr-only" role="status">{text}</span>;
}
