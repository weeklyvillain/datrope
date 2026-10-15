import type { Note } from "@datrope/core";
import { describe, expect, it, vi } from "vitest";

const { updateNote } = vi.hoisted(() => ({ updateNote: vi.fn() }));
vi.mock("../../session", () => ({ client: { updateNote, onEvent: vi.fn() } }));

import { applyNoteEvent, initialNotes, putNote } from "./notes-model";
import { saveNote, useNotes } from "./notes-store";

const note = (title: string, at: string): Note => ({ id: "1", title, text: "", content: { type: "doc" }, created_at: at, updated_at: at });

describe("saveNote", () => {
  it("stores the saved copy even while the note is still marked dirty", async () => {
    useNotes.setState({ ...putNote({ ...initialNotes, summaries: [] }, note("", "2026-01-01T00:00:00Z")), dirty: { "1": true } });
    updateNote.mockResolvedValue(note("Raid roster", "2026-01-02T00:00:00Z"));
    await saveNote("1", { title: "Raid roster" });
    expect(useNotes.getState().notes["1"].title).toBe("Raid roster");
  });

  it("does not bring back a note deleted while its save was in flight", async () => {
    useNotes.setState({ ...putNote({ ...initialNotes, summaries: [] }, note("a", "2026-01-01T00:00:00Z")), dirty: {} });
    let finish!: (n: Note) => void;
    updateNote.mockReturnValue(new Promise<Note>((r) => { finish = r; }));
    const saving = saveNote("1", { title: "b" });
    useNotes.setState((s) => applyNoteEvent(s, "NOTE_DELETE", { id: "1" }));
    finish(note("b", "2026-01-02T00:00:00Z"));
    await saving;
    expect(useNotes.getState().notes["1"]).toBeUndefined();
    expect(useNotes.getState().summaries).toEqual([]);
    expect(useNotes.getState().missing["1"]).toBe(true);
  });
});
