export const SNIPPET_CHARS = 1500;
export const SNIPPET_LINES = 40;

/** Whether a paste should become a snippet file rather than message text.
 *  `room` is how many characters still fit once the paste replaces the selection. */
export function shouldSnippet(pasted: string, room: number, canAttach: boolean): boolean {
  if (!canAttach) return false;
  return pasted.length > SNIPPET_CHARS || pasted.split("\n").length > SNIPPET_LINES || pasted.length > room;
}

/** A fenced code block around `selected`; the caret goes after it, or inside it when empty. */
export function wrapCodeBlock(selected: string, lang: string, atLineStart: boolean, atLineEnd: boolean): { value: string; caret: number } {
  const body = selected.endsWith("\n") ? selected.slice(0, -1) : selected;
  const open = `${atLineStart ? "" : "\n"}\`\`\`${lang}\n`;
  const fenced = `${open}${body}\n\`\`\``;
  // Text after the selection on its line moves below the closing fence.
  const value = atLineEnd ? fenced : `${fenced}\n`;
  return { value, caret: body ? fenced.length : open.length };
}

const EXTENSIONS: Record<string, string> = {
  typescript: "ts", javascript: "js", python: "py", go: "go", rust: "rs", json: "json", yaml: "yaml",
  bash: "sh", shell: "sh", csharp: "cs", cpp: "cpp", c: "c", java: "java", kotlin: "kt", ruby: "rb",
  php: "php", swift: "swift", sql: "sql", xml: "xml", css: "css", scss: "scss", markdown: "md",
  ini: "ini", diff: "diff", lua: "lua", powershell: "ps1", dockerfile: "dockerfile", makefile: "mk",
};

/** The file extension for a highlight.js language name. */
export function extensionForLanguage(lang: string | undefined): string {
  return (lang && EXTENSIONS[lang]) || "txt";
}

/** `main.go` → `go`; a name without a dot (`Dockerfile`) is its own language hint. */
export function fileExtension(filename: string): string {
  const name = filename.toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : name;
}

/** A user-typed snippet name, trimmed and without path separators; `fallback` when blank. */
export function snippetName(input: string, fallback: string): string {
  const name = input.trim().replace(/[/\\]/g, "_");
  return name || fallback;
}

/** The lines of a text file, whatever its line endings; a final newline does not start a line. */
export function splitLines(text: string): string[] {
  const t = text.replace(/\r\n?/g, "\n");
  return (t.endsWith("\n") ? t.slice(0, -1) : t).split("\n");
}
