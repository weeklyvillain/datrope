import type { createLowlight } from "lowlight";
import { useEffect, useState } from "react";

export type Lowlight = ReturnType<typeof createLowlight>;

// Below this highlight.js relevance a guess is too likely wrong to act on (prose scores low).
const CONFIDENT = 5;
// Guessing runs every grammar over the text; a prefix is enough to tell.
const GUESS_CHARS = 5000;

let instance: Lowlight | null = null;
let loading: Promise<Lowlight> | null = null;

/** Loads the highlighter (its own chunk) once. */
export function loadHighlighter(): Promise<Lowlight> {
  loading ??= import("./lowlight-setup").then((m) => (instance = m.lowlight)).catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** The highlighter if it has loaded, else null. */
export function highlighter(): Lowlight | null {
  return instance;
}

/** The highlighter, loading it on first use; null until it is ready. */
export function useHighlighter(): Lowlight | null {
  const [hl, setHl] = useState(instance);
  useEffect(() => {
    if (!hl) void loadHighlighter().then(setHl).catch(() => undefined);
  }, [hl]);
  return hl;
}

/** The language `text` most looks like, or null when nothing matched or the highlighter is not loaded. */
export function guessLanguage(text: string): { lang: string; confident: boolean } | null {
  if (!instance) return null;
  const { data } = instance.highlightAuto(text.slice(0, GUESS_CHARS));
  if (!data?.language) return null;
  return { lang: data.language, confident: (data.relevance ?? 0) >= CONFIDENT };
}
