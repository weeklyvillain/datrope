import { ApiError, type Note } from "@datrope/core";
import { create } from "zustand";
import { client } from "../../session";
import { applyNoteEvent, dropNote, initialNotes, putNote, setDirtyIn, type NotesState } from "./notes-model";

export const useNotes = create<NotesState>(() => initialNotes);

let synced = false;
/** Follows NOTE_* events from the first use on; they come from this and my other devices. */
function sync() {
  if (synced) return;
  synced = true;
  client.onEvent((type, data) => {
    if (type.startsWith("NOTE_")) useNotes.setState((s) => applyNoteEvent(s, type, data));
  });
}

export async function loadNotes() {
  sync();
  const list = await client.listNotes();
  useNotes.setState({ summaries: list });
}

export async function openNote(id: string) {
  sync();
  if (useNotes.getState().notes[id]) return;
  try {
    const n = await client.getNote(id);
    useNotes.setState((s) => putNote(s, n));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) useNotes.setState((s) => dropNote(s, id));
    else throw e;
  }
}

export async function newNote(): Promise<Note> {
  sync();
  const n = await client.createNote();
  useNotes.setState((s) => putNote(s, n));
  return n;
}

export function setDirty(id: string, dirty: boolean) {
  useNotes.setState((s) => setDirtyIn(s, id, dirty));
}

/** Saves a patch; a note deleted elsewhere (404) is dropped, and the error rethrown. */
export async function saveNote(id: string, patch: { title?: string; content?: Record<string, unknown>; text?: string }) {
  try {
    const n = await client.updateNote(id, patch);
    // Always the saved copy (the editor and title input keep showing pending edits while the note is dirty),
    // unless the note was deleted while this save was in flight.
    useNotes.setState((s) => (s.missing[id] ? s : putNote(s, n)));
    return n;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) useNotes.setState((s) => dropNote(s, id));
    throw e;
  }
}

export async function deleteNote(id: string) {
  await client.deleteNote(id);
  useNotes.setState((s) => dropNote(s, id));
}
