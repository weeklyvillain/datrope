import type { Note } from "@datrope/core";
import { describe, expect, it } from "vitest";
import { applyNoteEvent, displayTitle, initialNotes, previewOf, putNote, shouldReload, shownTitle, summaryOf, type NotesState } from "./notes-model";

const note = (id: string, title: string, text: string, at: string): Note => ({
  id, title, text, content: { type: "doc" }, created_at: at, updated_at: at,
});

describe("notes model", () => {
  it("previews collapse whitespace and cut at 140 characters", () => {
    expect(previewOf("a\n\n  b\tc")).toBe("a b c");
    expect(previewOf("x".repeat(200))).toHaveLength(140);
  });
  it("shows Untitled for blank titles", () => {
    expect(displayTitle("")).toBe("Untitled");
    expect(displayTitle("  ")).toBe("Untitled");
    expect(displayTitle("Raid")).toBe("Raid");
  });
  it("NOTE_CREATE adds a summary on top, once", () => {
    let s: NotesState = { ...initialNotes, summaries: [summaryOf(note("1", "old", "", "2026-01-01T00:00:00Z"))] };
    const created = summaryOf(note("2", "new", "", "2026-01-02T00:00:00Z"));
    s = applyNoteEvent(s, "NOTE_CREATE", created);
    s = applyNoteEvent(s, "NOTE_CREATE", created);
    expect(s.summaries!.map((n) => n.id)).toEqual(["2", "1"]);
  });
  it("NOTE_UPDATE moves the note to the top and replaces a clean note", () => {
    let s = putNote(putNote({ ...initialNotes, summaries: [] }, note("1", "a", "", "2026-01-01T00:00:00Z")), note("2", "b", "", "2026-01-02T00:00:00Z"));
    s = applyNoteEvent(s, "NOTE_UPDATE", note("1", "a2", "t", "2026-01-03T00:00:00Z"));
    expect(s.summaries!.map((n) => n.id)).toEqual(["1", "2"]);
    expect(s.notes["1"].title).toBe("a2");
  });
  it("keeps dirty note: a remote update does not replace the local body, but takes the title", () => {
    let s = putNote({ ...initialNotes, summaries: [] }, { ...note("1", "mine", "local text", "2026-01-01T00:00:00Z"), content: { type: "doc", local: true } });
    s = { ...s, dirty: { "1": true } };
    s = applyNoteEvent(s, "NOTE_UPDATE", note("1", "theirs", "remote text", "2026-01-02T00:00:00Z"));
    expect(s.notes["1"].content).toEqual({ type: "doc", local: true });
    expect(s.notes["1"].text).toBe("local text");
    expect(s.notes["1"].updated_at).toBe("2026-01-01T00:00:00Z"); // no editor reload
    expect(s.notes["1"].title).toBe("theirs"); // the title input shows typed text only while focused
    expect(s.summaries![0].title).toBe("theirs");
  });
  it("NOTE_DELETE removes it and marks it missing", () => {
    let s = putNote({ ...initialNotes, summaries: [] }, note("1", "a", "", "2026-01-01T00:00:00Z"));
    s = applyNoteEvent(s, "NOTE_DELETE", { id: "1" });
    expect(s.summaries).toEqual([]);
    expect(s.notes["1"]).toBeUndefined();
    expect(s.missing["1"]).toBe(true);
  });
  it("ignores other events and leaves an unloaded list unloaded", () => {
    expect(applyNoteEvent(initialNotes, "MESSAGE_CREATE", {})).toBe(initialNotes);
    expect(applyNoteEvent(initialNotes, "NOTE_UPDATE", note("1", "a", "", "2026-01-01T00:00:00Z")).summaries).toBeNull();
  });
});

describe("shouldReload", () => {
  const doc = { type: "doc", content: [{ type: "paragraph" }] };
  it("reloads a clean, unfocused editor showing other content", () => {
    expect(shouldReload({ current: { type: "doc" }, incoming: doc, dirty: false, focused: false })).toBe(true);
  });
  it("never reloads identical content, so the caret stays put", () => {
    expect(shouldReload({ current: { ...doc }, incoming: doc, dirty: false, focused: false })).toBe(false);
  });
  it("never reloads over pending edits or a focused editor", () => {
    expect(shouldReload({ current: { type: "doc" }, incoming: doc, dirty: true, focused: false })).toBe(false);
    expect(shouldReload({ current: { type: "doc" }, incoming: doc, dirty: false, focused: true })).toBe(false);
  });
});

describe("shownTitle", () => {
  it("keeps the typed title while the input is being edited, trailing space included", () => {
    expect(shownTitle({ local: "Raid ", stored: "Raid", editing: true })).toBe("Raid ");
  });
  it("shows the stored title when not editing, or before any typing", () => {
    expect(shownTitle({ local: "Raid ", stored: "Raid roster", editing: false })).toBe("Raid roster");
    expect(shownTitle({ local: undefined, stored: "Raid", editing: true })).toBe("Raid");
  });
});
