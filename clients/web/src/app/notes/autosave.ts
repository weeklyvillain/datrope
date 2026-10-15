import { ApiError } from "@datrope/core";
import { useEffect } from "react";
import { create } from "zustand";
import { saveNote, setDirty } from "./notes-store";

export type SaveStatus = "idle" | "saving" | "saved" | "error" | "deleted";
export type Patch = { title?: string; content?: Record<string, unknown>; text?: string };

type Opts = {
  delay: number;
  save: (id: string, p: Patch) => Promise<unknown>;
  onStatus: (s: SaveStatus) => void;
  onDirty: (id: string, dirty: boolean) => void;
};

/** Batches a note's edits and saves them `delay` ms after the last one; one note pending at a time, saves in order. */
export function createSaver({ delay, save, onStatus, onDirty }: Opts) {
  let id: string | null = null;
  let patch: Patch = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();

  const run = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    if (id === null) return running;
    const target = id, sent = patch;
    id = null;
    patch = {};
    onStatus("saving");
    running = running.then(() => save(target, sent)).then(
      () => {
        if (id !== target) onDirty(target, false); // otherwise newer edits to it are still pending
        onStatus(id === null ? "saved" : "saving");
      },
      (e: unknown) => {
        if (e instanceof ApiError && e.status === 404) {
          if (id === target) { id = null; patch = {}; clearTimeout(timer); }
          onDirty(target, false);
          onStatus("deleted");
          return;
        }
        if (id === target) patch = { ...sent, ...patch };
        else if (id === null) { id = target; patch = sent; }
        onStatus("error");
      },
    );
    return running;
  };

  return {
    edit(noteId: string, p: Patch) {
      if (id !== null && id !== noteId) void run();
      id = noteId;
      patch = { ...patch, ...p };
      onDirty(noteId, true);
      clearTimeout(timer);
      timer = setTimeout(() => void run(), delay);
    },
    flush: run,
    retry: run,
    /** Edits not yet sent, or kept after a failed save. */
    pending: () => id !== null,
  };
}

const useSaveStatus = create<{ status: SaveStatus }>(() => ({ status: "idle" }));

let saver: ReturnType<typeof createSaver> | undefined;
/** One saver for the app: a note's queued or failed edits outlive its view, and go out before another note's. */
export function noteSaver() {
  if (!saver) {
    const s = createSaver({ delay: 800, save: saveNote, onStatus: (status) => useSaveStatus.setState({ status }), onDirty: setDirty });
    saver = s;
    // Closing the page with edits waiting: send them, and ask the browser to hold the page while they go.
    if (typeof window !== "undefined") window.addEventListener("beforeunload", (e) => {
      if (!s.pending()) return;
      void s.flush();
      e.preventDefault();
    });
  }
  return saver;
}

/** The open note's saver: 800 ms debounce, flushed when the note's view closes. */
export function useAutosave() {
  const s = noteSaver();
  const status = useSaveStatus((x) => x.status);
  useEffect(() => () => void s.flush(), [s]);
  return { status, edit: s.edit, flush: s.flush, retry: s.retry };
}
