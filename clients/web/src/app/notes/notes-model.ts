import type { Note, NoteSummary } from "@datrope/core";

export type NotesState = {
  summaries: NoteSummary[] | null; // null until loaded
  notes: Record<string, Note>;
  dirty: Record<string, true>; // local edits not yet saved
  missing: Record<string, true>; // deleted, or never existed
};

export const initialNotes: NotesState = { summaries: null, notes: {}, dirty: {}, missing: {} };

export function previewOf(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ").slice(0, 140);
}

export function displayTitle(title: string): string {
  return title.trim() || "Untitled";
}

export function summaryOf(n: Note): NoteSummary {
  return { id: n.id, title: n.title, preview: previewOf(n.text), updated_at: n.updated_at };
}

function without<T>(rec: Record<string, T>, id: string): Record<string, T> {
  if (!(id in rec)) return rec;
  const out = { ...rec };
  delete out[id];
  return out;
}

/** Puts a summary on top of the list (newest first), replacing any older copy. */
function upsert(list: NoteSummary[] | null, sum: NoteSummary): NoteSummary[] | null {
  return list && [sum, ...list.filter((n) => n.id !== sum.id)];
}

export function putNote(s: NotesState, n: Note): NotesState {
  return { ...s, summaries: upsert(s.summaries, summaryOf(n)), notes: { ...s.notes, [n.id]: n }, missing: without(s.missing, n.id) };
}

export function dropNote(s: NotesState, id: string): NotesState {
  return {
    summaries: s.summaries && s.summaries.filter((n) => n.id !== id),
    notes: without(s.notes, id),
    dirty: without(s.dirty, id),
    missing: { ...s.missing, [id]: true },
  };
}

export function setDirtyIn(s: NotesState, id: string, dirty: boolean): NotesState {
  return { ...s, dirty: dirty ? { ...s.dirty, [id]: true } : without(s.dirty, id) };
}

export function applyNoteEvent(s: NotesState, type: string, data: unknown): NotesState {
  switch (type) {
    case "NOTE_CREATE": {
      const sum = data as NoteSummary;
      return !s.summaries || s.summaries.some((n) => n.id === sum.id) ? s : { ...s, summaries: upsert(s.summaries, sum) };
    }
    case "NOTE_UPDATE": {
      const n = data as Note;
      const summaries = upsert(s.summaries, summaryOf(n));
      const local = s.notes[n.id];
      if (!local) return { ...s, summaries };
      // Unsaved local edits keep the body (and its updated_at, so the editor doesn't reload); the title is safe to take.
      if (s.dirty[n.id]) return { ...s, summaries, notes: { ...s.notes, [n.id]: { ...local, title: n.title } } };
      return { ...s, summaries, notes: { ...s.notes, [n.id]: n } };
    }
    case "NOTE_DELETE":
      return dropNote(s, (data as { id: string }).id);
    default:
      return s;
  }
}

/** Whether the editor should take a newer stored copy: only when nothing local could be lost and the text differs. */
export function shouldReload({ current, incoming, dirty, focused }: {
  current: Record<string, unknown>; incoming: Record<string, unknown>; dirty: boolean; focused: boolean;
}): boolean {
  return !dirty && !focused && JSON.stringify(current) !== JSON.stringify(incoming);
}

/** The title input's value: what was typed while it is being edited (trailing spaces and all), else the stored title. */
export function shownTitle({ local, stored, editing }: { local: string | undefined; stored: string; editing: boolean }): string {
  return editing && local !== undefined ? local : stored;
}
