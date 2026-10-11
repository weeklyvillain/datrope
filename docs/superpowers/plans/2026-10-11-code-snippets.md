# Code Snippets and Text-File Previews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add syntax-highlighted code blocks to messages, a code-block button and shortcut to the composer, automatic conversion of long pastes into snippet files, and inline previews (plus a full-view dialog) for uploaded text and code files.

**Architecture:**
- One highlighter module (`lowlight` + highlight.js grammars) loads lazily and feeds a shared `CodeBlock` component.
- Markdown `pre` blocks and the new `CodeFileView` attachment both render through `CodeBlock`.
- Composer logic lives in pure helpers (`src/lib/code.ts`) so it can be unit-tested without a DOM.
- No server changes.

**Tech Stack:** React 18, react-markdown 9, lowlight 3.3.0, highlight.js 11.11.1, hast-util-to-jsx-runtime 2.3.6, shadcn/ui (Radix), Tailwind v4, Vitest (node env, `renderToStaticMarkup`), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-11-code-snippets-design.md`

## Global Constraints

- **Scope:** web client only (`clients/web`), plus one helper method in `clients/core/src/client.ts`. No server changes.
- **No commits:** never commit. Each task ends by **staging** its files (`git add`); the user commits.
- **Writing files on this machine:** the Write/Edit tools are blocked for project files. Write and modify files via Bash heredocs, or write to the scratchpad and `cp`.
- **Dependencies:** D: is exFAT, so `pnpm add` cannot link packages. Edit `package.json` by hand, then run `pnpm install` (root `.npmrc` uses `node-linker=hoisted`).
- **Colors:** no hardcoded colors in components. Syntax colors are `--syntax-*` tokens in `src/styles.css` (`:root` + `@theme inline`). The app is dark only, so no `dark:` variants.
- **Components:** use shadcn primitives (`Button`, `Dialog`, `Input`) and `cn()`, and import via `@/`. `Button` defaults to `type="button"`.
- **Snippet thresholds:** more than **1500** characters, more than **40** lines, or the paste does not fit in the room left under `MAX_LENGTH` (4000).
- **Preview limits:** a file is previewed when its `content_type` starts with `text/` and `size <= 1_048_576` bytes. The inline preview shows **15** lines.
- **Shortcut:** **Ctrl/Cmd+E** wraps the selection in a code block.
- **Accessible names** (e2e depends on them): `Code block`, `Copy code`, `Download`, `Show all N lines`, `Paste as text`, `Snippet file name`.
- **Rendering:** highlighted output is built as React elements from HAST. Never use `dangerouslySetInnerHTML`.

## Review Focus

1. **Code containing HTML.** `<img src=x onerror=alert(1)>` in an html block or a `.html` file must render as text, never as markup. Tests: Task 3 and Task 5.
2. **Windows line endings and a trailing newline in an uploaded file.** `\r\n` must not leave a stray `\r`, and a final `\n` must not count as an extra line in "Show all N lines". Test: Task 5 (via `splitLines`, Task 2).
3. **Long paste in a channel without the attach permission.** It must paste normally (truncated by `maxLength`), not vanish. Test: Task 2 (`shouldSnippet` with `canAttach=false`).
4. **Renaming a snippet.**
   - An empty or whitespace name keeps a valid name. Test: `snippetName` in Task 2.
   - A rename while the first upload is still running must not let the stale upload overwrite the new one. Guarded with a per-key run id in Task 7.
5. **Unknown fence language** (```` ```foo ````). It renders as plaintext labelled `foo`, with no crash. Tests: Tasks 3 and 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `clients/web/src/lib/lowlight-setup.ts` (new) | Builds the lowlight instance with its registered languages. Only ever dynamically imported. |
| `clients/web/src/lib/highlighter.ts` (new) | Lazy loader, `useHighlighter()` hook, sync `highlighter()` accessor, `guessLanguage()`. |
| `clients/web/src/lib/code.ts` (new) | Pure helpers: `shouldSnippet`, `wrapCodeBlock`, `extensionForLanguage`, `fileExtension`, `snippetName`, `splitLines`. |
| `clients/web/src/components/code-block.tsx` (new) | `CodeBlock`: highlighted code; a header with title or language, actions, and a copy button; optional line numbers. |
| `clients/web/src/chat/Markdown.tsx` | The `pre` renderer goes through `CodeBlock`. |
| `clients/web/src/app/attachments/FileChip.tsx` (new) | The existing download chip, extracted from `MessageList`. |
| `clients/web/src/app/attachments/CodeFile.tsx` (new) | `isCodeFile`; `CodeFileView` (presentational); `CodeFileAttachment` (fetches the file, falls back to `FileChip`). |
| `clients/web/src/app/MessageList.tsx` | `Attachments` uses `CodeFileAttachment` and `FileChip`. |
| `clients/core/src/client.ts` | `fetchText(path)` with auth headers. |
| `clients/web/src/hooks/use-uploads.ts` | `addText`, `rename`, `PendingFile.text`, and a guard against stale uploads. |
| `clients/web/src/app/Composer.tsx` | Code button, Ctrl/Cmd+E, paste-to-snippet, and the snippet chip UI. |
| `clients/web/src/styles.css` | `--syntax-*` tokens and the `.code-block` and `.hljs-*` styles. Replaces the `.chat-md pre` rules. |
| `clients/web/e2e/chat.spec.ts` | New e2e test for code snippets. |

---

### Task 1: Highlighter module

**Files:**
- Modify: `clients/web/package.json` (dependencies)
- Create: `clients/web/src/lib/lowlight-setup.ts`
- Create: `clients/web/src/lib/highlighter.ts`
- Test: `clients/web/src/lib/highlighter.test.ts`

**Interfaces:**
- Produces:
  - `loadHighlighter(): Promise<Lowlight>`
  - `highlighter(): Lowlight | null` (synchronous; null until loaded)
  - `useHighlighter(): Lowlight | null` (re-renders once loaded)
  - `guessLanguage(text: string): { lang: string; confident: boolean } | null` (null when the highlighter is not loaded or nothing matched)
  - `type Lowlight = ReturnType<typeof createLowlight>`

- [ ] **Step 1: Add the dependencies**

In `clients/web/package.json`, add these to `"dependencies"` in alphabetical order:

```json
"hast-util-to-jsx-runtime": "2.3.6",
"highlight.js": "11.11.1",
"lowlight": "3.3.0",
```

Then run `pnpm install` from the repo root.

- [ ] **Step 2: Write the failing test**

`clients/web/src/lib/highlighter.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { guessLanguage, highlighter, loadHighlighter } from "./highlighter";

describe("highlighter", () => {
  beforeAll(async () => {
    await loadHighlighter();
  });

  it("is available synchronously once loaded", () => {
    expect(highlighter()).not.toBeNull();
  });

  it.each(["ts", "tsx", "go", "py", "rs", "json", "yaml", "sh", "powershell", "dockerfile", "toml", "html", "sql"])(
    "registers %s", (lang) => {
      expect(highlighter()!.registered(lang)).toBe(true);
    });

  it.each([
    ["typescript", "interface User { id: string; name?: string }\nexport function greet(u: User): string {\n  return `hi ${u.name ?? u.id}`;\n}"],
    ["go", "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tfmt.Println(\"hello\")\n}"],
    ["python", "def greet(name: str) -> str:\n    return f\"hi {name}\"\n\nif __name__ == \"__main__\":\n    print(greet('bob'))"],
    ["json", "{\n  \"name\": \"datrope\",\n  \"private\": true,\n  \"version\": \"1.0.0\"\n}"],
  ])("guesses %s confidently", (lang, code) => {
    expect(guessLanguage(code)).toEqual({ lang, confident: true });
  });

  it("is not confident about prose", () => {
    expect(guessLanguage("Hej! Vi ses imorgon vid sju, ta med snacks och spel.")?.confident ?? false).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run (from `clients/web`): `pnpm vitest run src/lib/highlighter.test.ts`
Expected: FAIL with "Failed to resolve import ./highlighter".

- [ ] **Step 4: Write the implementation**

`clients/web/src/lib/lowlight-setup.ts`:

```ts
import dockerfile from "highlight.js/lib/languages/dockerfile";
import powershell from "highlight.js/lib/languages/powershell";
import { common, createLowlight } from "lowlight";

// lowlight's common set (ts/js incl. tsx/jsx, go, python, rust, java, kotlin, c, cpp, csharp, json,
// yaml, ini/toml, sql, bash/shell, xml/html, css, scss, markdown, diff, lua, php, ruby, swift, ...)
// plus a few the chat sees often.
export const lowlight = createLowlight(common);
lowlight.register({ dockerfile, powershell });
```

`clients/web/src/lib/highlighter.ts`:

```ts
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
  loading ??= import("./lowlight-setup").then((m) => (instance = m.lowlight));
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
    if (!hl) void loadHighlighter().then(setHl);
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/highlighter.test.ts`
Expected: PASS.

The test pins behaviour on realistic code, not one exact score. If it fails:
- **"is not confident about prose" fails:** raise `CONFIDENT` to 8 and re-run.
- **A code sample then loses confidence:** lengthen that sample rather than lowering the threshold.
- **A sample is guessed as a sibling language** (for example `javascript` for the TS sample): add more type annotations to the sample.

- [ ] **Step 6: Type-check and stage**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add clients/web/package.json clients/web/src/lib/lowlight-setup.ts clients/web/src/lib/highlighter.ts clients/web/src/lib/highlighter.test.ts
git status --short | grep -i lock   # stage the lockfile that changed, too
```

---

### Task 2: Pure code helpers

**Files:**
- Create: `clients/web/src/lib/code.ts`
- Test: `clients/web/src/lib/code.test.ts`

**Interfaces:**
- Produces:
  - `SNIPPET_CHARS = 1500`, `SNIPPET_LINES = 40`
  - `shouldSnippet(pasted: string, room: number, canAttach: boolean): boolean`. `room` is how many characters still fit in the message once the paste replaces the selection.
  - `wrapCodeBlock(selected: string, lang: string, atLineStart: boolean): { value: string; caret: number }`. `caret` is relative to the start of `value`.
  - `extensionForLanguage(lang: string | undefined): string`. Returns `"txt"` by default.
  - `fileExtension(filename: string): string`. The lower-case extension, or the whole lower-case name when there is no dot (`Dockerfile` → `dockerfile`).
  - `snippetName(input: string, fallback: string): string`
  - `splitLines(text: string): string[]`. Normalises `\r\n` and `\r`, and ignores one trailing newline.

- [ ] **Step 1: Write the failing test**

`clients/web/src/lib/code.test.ts`:

````ts
import { describe, expect, it } from "vitest";
import { extensionForLanguage, fileExtension, shouldSnippet, snippetName, splitLines, wrapCodeBlock } from "./code";

describe("shouldSnippet", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
  it("keeps short pastes as text", () => {
    expect(shouldSnippet("const a = 1;", 4000, true)).toBe(false);
    expect(shouldSnippet("x".repeat(1500), 4000, true)).toBe(false);
    expect(shouldSnippet(lines(40), 4000, true)).toBe(false);
  });
  it("snippets long or tall pastes", () => {
    expect(shouldSnippet("x".repeat(1501), 4000, true)).toBe(true);
    expect(shouldSnippet(lines(41), 4000, true)).toBe(true);
  });
  it("snippets a paste that does not fit in the room left", () => {
    expect(shouldSnippet("x".repeat(100), 99, true)).toBe(true);
  });
  it("never snippets without the attach permission", () => {
    expect(shouldSnippet("x".repeat(5000), 10, false)).toBe(false);
  });
});

describe("wrapCodeBlock", () => {
  it("wraps a selection with the language", () => {
    expect(wrapCodeBlock("a = 1", "python", true)).toEqual({ value: "```python\na = 1\n```", caret: 19 });
  });
  it("puts the caret inside an empty block", () => {
    const { value, caret } = wrapCodeBlock("", "", true);
    expect(value).toBe("```\n\n```");
    expect(value.slice(0, caret)).toBe("```\n");
  });
  it("starts on a new line mid-line", () => {
    expect(wrapCodeBlock("x", "", false).value).toBe("\n```\nx\n```");
  });
  it("drops one trailing newline of the selection", () => {
    expect(wrapCodeBlock("x\n", "", true).value).toBe("```\nx\n```");
  });
});

describe("file names", () => {
  it.each([
    ["typescript", "ts"], ["javascript", "js"], ["python", "py"], ["go", "go"], ["rust", "rs"],
    ["json", "json"], ["yaml", "yaml"], ["bash", "sh"], ["shell", "sh"], ["csharp", "cs"], ["cpp", "cpp"],
    ["markdown", "md"], ["xml", "xml"], ["powershell", "ps1"], ["kotlin", "kt"], ["ruby", "rb"],
    ["plaintext", "txt"], ["something-else", "txt"],
  ])("%s → .%s", (lang, ext) => expect(extensionForLanguage(lang)).toBe(ext));
  it("defaults to txt", () => expect(extensionForLanguage(undefined)).toBe("txt"));

  it.each([["main.go", "go"], ["App.TSX", "tsx"], ["Dockerfile", "dockerfile"], ["archive.tar.gz", "gz"], ["notes.txt", "txt"]])(
    "%s → %s", (name, ext) => expect(fileExtension(name)).toBe(ext));

  it("keeps a snippet name valid", () => {
    expect(snippetName("  util.ts ", "snippet.txt")).toBe("util.ts");
    expect(snippetName("   ", "snippet.txt")).toBe("snippet.txt");
    expect(snippetName("a/b\\c.ts", "snippet.txt")).toBe("a_b_c.ts");
  });
});

describe("splitLines", () => {
  it("normalises CRLF and ignores one trailing newline", () => {
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(splitLines("a\rb")).toEqual(["a", "b"]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
    expect(splitLines("")).toEqual([""]);
  });
});
````

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/code.test.ts`
Expected: FAIL with "Failed to resolve import ./code".

- [ ] **Step 3: Write the implementation**

`clients/web/src/lib/code.ts`:

````ts
export const SNIPPET_CHARS = 1500;
export const SNIPPET_LINES = 40;

/** Whether a paste should become a snippet file rather than message text.
 *  `room` is how many characters still fit once the paste replaces the selection. */
export function shouldSnippet(pasted: string, room: number, canAttach: boolean): boolean {
  if (!canAttach) return false;
  return pasted.length > SNIPPET_CHARS || pasted.split("\n").length > SNIPPET_LINES || pasted.length > room;
}

/** A fenced code block around `selected`; the caret goes after it, or inside it when empty. */
export function wrapCodeBlock(selected: string, lang: string, atLineStart: boolean): { value: string; caret: number } {
  const body = selected.endsWith("\n") ? selected.slice(0, -1) : selected;
  const open = `${atLineStart ? "" : "\n"}\`\`\`${lang}\n`;
  const value = `${open}${body}\n\`\`\``;
  return { value, caret: body ? value.length : open.length };
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
````

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/code.test.ts`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add clients/web/src/lib/code.ts clients/web/src/lib/code.test.ts
```

---

### Task 3: `CodeBlock` component and syntax tokens

**Files:**
- Create: `clients/web/src/components/code-block.tsx`
- Modify: `clients/web/src/styles.css`. Add tokens to `:root` and `@theme inline`, and replace the `.chat-md pre` / `.chat-md pre code` rules (around lines 112-122).
- Test: `clients/web/src/components/code-block.test.tsx`

**Interfaces:**
- Consumes: `useHighlighter`, `loadHighlighter` (Task 1).
- Produces: `CodeBlock(props: { code: string; lang?: string; lineNumbers?: boolean; title?: ReactNode; actions?: ReactNode; copyText?: string; className?: string })`.
  - The root element has class `code-block`.
  - The header shows, in order: `title`, else `lang`, else `"text"`; then `actions`; then a `Copy code` button that copies `copyText ?? code`.

- [ ] **Step 1: Write the failing test**

`clients/web/src/components/code-block.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { loadHighlighter } from "@/lib/highlighter";
import { CodeBlock } from "./code-block";

const html = (el: JSX.Element) => renderToStaticMarkup(el);

describe("CodeBlock", () => {
  beforeAll(async () => {
    await loadHighlighter();
  });

  it("highlights a known language and labels it", () => {
    const out = html(<CodeBlock code={"const a = 1;"} lang="ts" />);
    expect(out).toContain('class="hljs-keyword"');
    expect(out).toContain(">ts<");
    expect(out).toContain('aria-label="Copy code"');
  });

  it("renders an unknown language as plain text with its label", () => {
    const out = html(<CodeBlock code={"a <- b"} lang="foo" />);
    expect(out).not.toContain("hljs-");
    expect(out).toContain(">foo<");
    expect(out).toContain("a &lt;- b");
  });

  it("calls a block without a language text", () => {
    expect(html(<CodeBlock code="x" />)).toContain(">text<");
  });

  it("never turns code into markup", () => {
    const out = html(<CodeBlock code={'<img src=x onerror="alert(1)">'} lang="html" />);
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;");
  });

  it("numbers lines when asked", () => {
    expect(html(<CodeBlock code={"a\nb\nc"} lineNumbers />)).toContain("1\n2\n3");
  });

  it("shows a title and actions instead of the language", () => {
    const out = html(<CodeBlock code="x" lang="ts" title="main.ts" actions={<a href="/f">Download</a>} />);
    expect(out).toContain("main.ts");
    expect(out).toContain("Download");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/components/code-block.test.tsx`
Expected: FAIL with "Failed to resolve import ./code-block".

- [ ] **Step 3: Write the component**

`clients/web/src/components/code-block.tsx`:

```tsx
import { toJsxRuntime, type Jsx } from "hast-util-to-jsx-runtime";
import { Check, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { Button } from "@/components/ui/button";
import { useHighlighter } from "@/lib/highlighter";
import { cn } from "@/lib/utils";

/** A block of code, syntax-highlighted when its language is known, with a copy button. */
export function CodeBlock({ code, lang, lineNumbers = false, title, actions, copyText, className }: {
  code: string; lang?: string; lineNumbers?: boolean; title?: ReactNode; actions?: ReactNode; copyText?: string; className?: string;
}) {
  const hl = useHighlighter();
  const known = !!hl && !!lang && hl.registered(lang);
  // HAST to React elements: tokens become spans, nothing is parsed as HTML.
  const body = known
    ? toJsxRuntime(hl.highlight(lang, code), { Fragment, jsx: jsx as Jsx, jsxs: jsxs as Jsx })
    : code;
  const count = lineNumbers ? code.split("\n").length : 0;
  return (
    <div className={cn("code-block overflow-hidden rounded-lg border bg-sidebar text-[13px]", className)}>
      <div className="flex items-center gap-2 border-b bg-card py-1 pl-3 pr-1 text-xs text-muted-foreground">
        <span className="flex min-w-0 flex-1 items-center gap-2">{title ?? lang ?? "text"}</span>
        {actions}
        <CopyButton text={copyText ?? code} />
      </div>
      <div className="flex overflow-x-auto">
        {count > 0 && (
          <pre aria-hidden="true" className="select-none border-r px-3 py-2.5 text-right text-muted-foreground">
            {Array.from({ length: count }, (_, i) => i + 1).join("\n")}
          </pre>
        )}
        <pre className="flex-1 px-3 py-2.5"><code className={known ? `hljs language-${lang}` : undefined}>{body}</code></pre>
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button variant="ghost" size="icon-xs" aria-label="Copy code" title={copied ? "Copied" : "Copy code"}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}>
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
```

If `tsc` rejects the `Jsx` casts, use `jsx as unknown as Jsx`. The React and hast-util type signatures differ only nominally.

- [ ] **Step 4: Add the tokens and styles**

In `clients/web/src/styles.css`, add to `:root` after the `--avatar-8` line:

```css
  --syntax-keyword: #c678dd;
  --syntax-string: #98c379;
  --syntax-number: #d19a66;
  --syntax-comment: #6b7075;
  --syntax-function: #61afef;
  --syntax-type: #e5c07b;
  --syntax-variable: #e06c75;
  --syntax-meta: #56b6c2;
```

Add to `@theme inline`, next to the other `--color-*` entries:

```css
  --color-syntax-keyword: var(--syntax-keyword);
  --color-syntax-string: var(--syntax-string);
  --color-syntax-number: var(--syntax-number);
  --color-syntax-comment: var(--syntax-comment);
  --color-syntax-function: var(--syntax-function);
  --color-syntax-type: var(--syntax-type);
  --color-syntax-variable: var(--syntax-variable);
  --color-syntax-meta: var(--syntax-meta);
```

Replace the existing `.chat-md pre { ... }` block and the `.chat-md pre code { ... }` line with the rules below. The `.code-block code` rule has the same specificity as `.chat-md code`, so it must come **after** that rule; otherwise inline-code styling leaks into blocks.

```css
/* Code blocks (src/components/code-block.tsx), in messages and file previews. */
.code-block pre { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; margin: 0; white-space: pre; line-height: 1.5; }
.chat-md .code-block { margin-top: 6px; }
.code-block code { background: none; padding: 0; border-radius: 0; font-size: inherit; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-doctag { color: var(--syntax-keyword); }
.hljs-string, .hljs-regexp, .hljs-addition, .hljs-char.escape_ { color: var(--syntax-string); }
.hljs-number, .hljs-symbol, .hljs-attr, .hljs-attribute, .hljs-property { color: var(--syntax-number); }
.hljs-comment, .hljs-quote { color: var(--syntax-comment); font-style: italic; }
.hljs-title, .hljs-section, .hljs-title.function_ { color: var(--syntax-function); }
.hljs-type, .hljs-built_in, .hljs-title.class_, .hljs-selector-class { color: var(--syntax-type); }
.hljs-variable, .hljs-template-variable, .hljs-tag, .hljs-name, .hljs-deletion, .hljs-selector-id { color: var(--syntax-variable); }
.hljs-meta, .hljs-link, .hljs-operator { color: var(--syntax-meta); }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 600; }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/components/code-block.test.tsx`
Expected: PASS.

- [ ] **Step 6: Type-check and stage**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add clients/web/src/components/code-block.tsx clients/web/src/components/code-block.test.tsx clients/web/src/styles.css
```

---

### Task 4: Markdown code blocks through `CodeBlock`

**Files:**
- Modify: `clients/web/src/chat/Markdown.tsx` (the `components` map, around line 29)
- Test: `clients/web/src/chat/Markdown.test.tsx`

**Interfaces:**
- Consumes: `CodeBlock` (Task 3), `loadHighlighter` (Task 1).

- [ ] **Step 1: Update the tests so they fail**

In `clients/web/src/chat/Markdown.test.tsx`, change this existing row:

````ts
    ["```\nconst a = 1;\n```", "<pre><code>const a = 1;\n</code></pre>"],
````

to:

````ts
    ["```\nconst a = 1;\n```", 'class="code-block', ">text<", "<code>const a = 1;</code>"],
````

Add `beforeAll` to the vitest import and `import { loadHighlighter } from "@/lib/highlighter";` to the imports at the top. Then append:

````tsx
describe("code blocks", () => {
  beforeAll(async () => {
    await loadHighlighter();
  });

  it("highlights a fenced block with its language", () => {
    const out = html("```ts\nconst a: number = 1;\n```");
    expect(out).toContain('class="code-block');
    expect(out).toContain(">ts<");
    expect(out).toContain('class="hljs-keyword"');
  });

  it("leaves inline code alone", () => {
    expect(html("use `npm i`")).toContain("<code>npm i</code>");
    expect(html("use `npm i`")).not.toContain("code-block");
  });

  it("shows an unknown language as text", () => {
    expect(html("```foo\nbar\n```")).toContain(">foo<");
  });
});
````

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/chat/Markdown.test.tsx`
Expected: FAIL. The output still has a bare `<pre>` and no `code-block`.

- [ ] **Step 3: Add the `pre` renderer**

In `clients/web/src/chat/Markdown.tsx`, add the imports:

```tsx
import type { Element, ElementContent } from "hast";
import { CodeBlock } from "@/components/code-block";
```

Above `const components`:

```tsx
// The text of a HAST subtree (a code block's content, whatever plugins wrapped it in).
const textOf = (n: ElementContent): string =>
  n.type === "text" ? n.value : n.type === "element" ? n.children.map(textOf).join("") : "";

// ```lang blocks: the language is the code element's "language-x" class.
function codeOf(pre: Element | undefined): { code: string; lang?: string } {
  const code = pre?.children.find((c): c is Element => c.type === "element" && c.tagName === "code");
  const cls = (code?.properties.className as string[] | undefined)?.find((c) => c.startsWith("language-"));
  const text = code ? code.children.map(textOf).join("") : "";
  return { code: text.endsWith("\n") ? text.slice(0, -1) : text, lang: cls?.slice("language-".length) };
}
```

Add this as the first entry of the `components` map:

```tsx
  pre: ({ node }) => <CodeBlock {...codeOf(node)} />,
```

The `hast` types come with react-markdown's dependency tree. If `tsc` cannot resolve `hast`, add `"@types/hast": "3.0.4"` to `devDependencies` and run `pnpm install`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/chat/Markdown.test.tsx`
Expected: PASS, including all existing rows.

- [ ] **Step 5: Type-check and stage**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add clients/web/src/chat/Markdown.tsx clients/web/src/chat/Markdown.test.tsx
```

(Also stage `clients/web/package.json` and the lockfile if `@types/hast` was added.)

---

### Task 5: Text-file previews

**Files:**
- Modify: `clients/core/src/client.ts` (add `fetchText` next to `upload()`, around line 605)
- Create: `clients/web/src/app/attachments/FileChip.tsx`
- Create: `clients/web/src/app/attachments/CodeFile.tsx`
- Modify: `clients/web/src/app/MessageList.tsx` (`Attachments`, around lines 578-616)
- Test: `clients/web/src/app/attachments/CodeFile.test.tsx`

**Interfaces:**
- Consumes: `CodeBlock` (Task 3), `splitLines` and `fileExtension` (Task 2).
- Produces:
  - `client.fetchText(path: string): Promise<string>`
  - `FileChip({ attachment })`
  - `isCodeFile(a: Attachment): boolean`
  - `PREVIEW_LINES = 15`, `MAX_PREVIEW_BYTES = 1_048_576`
  - `CodeFileView({ attachment, text })`, where `text: string | undefined`; `undefined` renders a loading skeleton.
  - `CodeFileAttachment({ attachment })`

- [ ] **Step 1: Write the failing test**

`clients/web/src/app/attachments/CodeFile.test.tsx`:

```tsx
import type { Attachment } from "@datrope/core";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadHighlighter } from "@/lib/highlighter";
import { CodeFileView, isCodeFile } from "./CodeFile";

// The session module creates the client from window.location, which Node lacks.
vi.mock("@/session", () => ({
  client: { url: (p: string) => `https://chat.test${p}` },
  formatBytes: (n: number) => `${n} B`,
}));

const file: Attachment = {
  id: "5", channel_id: "3", filename: "main.go", content_type: "text/plain; charset=utf-8", size: 120, inline: false,
  url: "/api/attachments/5",
};
const lines = (n: number) => Array.from({ length: n }, (_, i) => `// line ${i}`).join("\r\n") + "\r\n";

describe("isCodeFile", () => {
  it("previews small text files only", () => {
    expect(isCodeFile(file)).toBe(true);
    expect(isCodeFile({ ...file, content_type: "text/html; charset=utf-8" })).toBe(true);
    expect(isCodeFile({ ...file, size: 1_048_577 })).toBe(false);
    expect(isCodeFile({ ...file, content_type: "application/octet-stream" })).toBe(false);
    expect(isCodeFile({ ...file, content_type: "image/png" })).toBe(false);
  });
});

describe("CodeFileView", () => {
  beforeAll(async () => {
    await loadHighlighter();
  });

  it("shows the first 15 lines highlighted, with the full count", () => {
    const out = renderToStaticMarkup(<CodeFileView attachment={file} text={lines(20)} />);
    expect(out).toContain("main.go");
    expect(out).toContain("// line 14");
    expect(out).not.toContain("// line 15");
    expect(out).toContain("Show all 20 lines");
    expect(out).not.toContain("\r");
    expect(out).toContain('download="main.go"');
  });

  it("has no Show all for a short file", () => {
    expect(renderToStaticMarkup(<CodeFileView attachment={file} text={lines(15)} />)).not.toContain("Show all");
  });

  it("shows a loading state before the text arrives", () => {
    expect(renderToStaticMarkup(<CodeFileView attachment={file} text={undefined} />)).toContain('aria-busy="true"');
  });

  it("shows an HTML file as text", () => {
    const out = renderToStaticMarkup(<CodeFileView attachment={{ ...file, filename: "x.html" }} text={'<img src=x onerror="alert(1)">'} />);
    expect(out).not.toContain("<img");
  });
});
```

If the `Attachment` literal fails type-checking because of required fields, copy the shape from `GifMedia.test.tsx` and add what `schema.d.ts` requires.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/app/attachments/CodeFile.test.tsx`
Expected: FAIL with "Failed to resolve import ./CodeFile".

- [ ] **Step 3: Add `fetchText` to the core client**

In `clients/core/src/client.ts`, next to `upload()`:

```ts
  /** The body of a file the server serves (an attachment), as text. */
  async fetchText(path: string): Promise<string> {
    const res = await fetch(this.url(path), { headers: this.authHeaders(), credentials: "include" });
    if (!res.ok) await this.throwApiError(res);
    return res.text();
  }
```

- [ ] **Step 4: Extract `FileChip`**

Create `clients/web/src/app/attachments/FileChip.tsx`. The JSX is moved verbatim from `MessageList.tsx`:

```tsx
import type { Attachment } from "@datrope/core";
import { client, formatBytes } from "@/session";

/** A download link for a file the chat does not show inline. */
export function FileChip({ attachment: a }: { attachment: Attachment }) {
  return (
    <a className="inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-foreground no-underline" href={client.url(a.url)} download={a.filename}>
      <span aria-hidden="true">📎</span>
      <span>{a.filename}</span>
      <span className="text-muted-foreground">{formatBytes(a.size)}</span>
    </a>
  );
}
```

- [ ] **Step 5: Write `CodeFile.tsx`**

`clients/web/src/app/attachments/CodeFile.tsx`:

```tsx
import type { Attachment } from "@datrope/core";
import { useEffect, useState } from "react";
import { CodeBlock } from "@/components/code-block";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fileExtension, splitLines } from "@/lib/code";
import { client, formatBytes } from "@/session";
import { FileChip } from "./FileChip";

export const PREVIEW_LINES = 15;
export const MAX_PREVIEW_BYTES = 1_048_576;

/** Whether to preview the attachment as code: a text file small enough to fetch. */
export function isCodeFile(a: Attachment): boolean {
  return a.content_type.startsWith("text/") && a.size <= MAX_PREVIEW_BYTES;
}

/** A text file in a message: its first lines highlighted, the whole file in a dialog. */
export function CodeFileView({ attachment: a, text }: { attachment: Attachment; text: string | undefined }) {
  const [open, setOpen] = useState(false);
  const lang = fileExtension(a.filename);
  const title = (
    <>
      <span className="truncate text-foreground">{a.filename}</span>
      <span>{formatBytes(a.size)}</span>
    </>
  );
  const download = (
    <Button asChild variant="ghost" size="xs">
      <a href={client.url(a.url)} download={a.filename}>Download</a>
    </Button>
  );
  if (text === undefined) {
    return (
      <div className="w-[560px] max-w-full overflow-hidden rounded-lg border bg-sidebar" aria-busy="true">
        <div className="border-b bg-card px-3 py-1.5 text-xs text-muted-foreground">{a.filename}</div>
        <div className="h-24 animate-pulse bg-muted" />
      </div>
    );
  }
  const lines = splitLines(text);
  return (
    <div className="flex w-[560px] max-w-full flex-col items-start gap-1">
      <CodeBlock className="w-full" code={lines.slice(0, PREVIEW_LINES).join("\n")} copyText={lines.join("\n")}
        lang={lang} title={title} actions={download} />
      {lines.length > PREVIEW_LINES && (
        <Button variant="link" size="xs" className="px-0" onClick={() => setOpen(true)}>Show all {lines.length} lines</Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{a.filename}</DialogTitle>
            <DialogDescription>{lines.length} lines · {formatBytes(a.size)}</DialogDescription>
          </DialogHeader>
          <CodeBlock className="max-h-[70vh] overflow-auto" code={lines.join("\n")} lang={lang} lineNumbers actions={download} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Fetches a text attachment and previews it; falls back to the download chip if that fails. */
export function CodeFileAttachment({ attachment: a }: { attachment: Attachment }) {
  const [text, setText] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    client.fetchText(a.url).then(
      (t) => live && setText(t),
      () => live && setFailed(true),
    );
    return () => { live = false; };
  }, [a.url]);
  if (failed) return <FileChip attachment={a} />;
  return <CodeFileView attachment={a} text={text} />;
}
```

- [ ] **Step 6: Use them in `Attachments`**

In `clients/web/src/app/MessageList.tsx`, inside `Attachments`, replace the final `return ( <a ...>📎...</a> );` in `others.map` with:

```tsx
        if (isCodeFile(a)) return <CodeFileAttachment key={a.id} attachment={a} />;
        return <FileChip key={a.id} attachment={a} />;
```

Add the imports:

```tsx
import { CodeFileAttachment, isCodeFile } from "./attachments/CodeFile";
import { FileChip } from "./attachments/FileChip";
```

Remove `formatBytes` from the `session` import only if nothing else in the file uses it. Check with `grep -n formatBytes clients/web/src/app/MessageList.tsx`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run src/app/attachments/CodeFile.test.tsx`
Expected: PASS.

- [ ] **Step 8: Type-check, run the full unit suite, and stage**

Run: `pnpm typecheck && pnpm test`
Expected: no type errors; all tests pass.

```bash
git add clients/core/src/client.ts clients/web/src/app/attachments/FileChip.tsx clients/web/src/app/attachments/CodeFile.tsx clients/web/src/app/attachments/CodeFile.test.tsx clients/web/src/app/MessageList.tsx
```

---

### Task 6: Composer code-block button and Ctrl/Cmd+E

**Files:**
- Modify: `clients/web/src/app/Composer.tsx`

**Interfaces:**
- Consumes: `wrapCodeBlock` (Task 2), `guessLanguage` and `loadHighlighter` (Task 1).

The wrapping logic is pinned by the `wrapCodeBlock` tests in Task 2. This task's UI wiring is verified by the e2e test in Task 8.

- [ ] **Step 1: Preload the highlighter**

Update the imports:

```tsx
import { CirclePlus, Code, Reply, Smile, X } from "lucide-react";
import { wrapCodeBlock } from "@/lib/code";
import { guessLanguage, loadHighlighter } from "@/lib/highlighter";
```

In `Composer`, next to the other `useEffect`s and **before** the `if (!canSend) return ...` early return:

```tsx
  // Guessing a pasted or wrapped snippet's language needs the highlighter ready.
  useEffect(() => {
    void loadHighlighter();
  }, []);
```

- [ ] **Step 2: Let `insert` place the caret anywhere in the inserted text**

Replace `insert` with:

```tsx
  // `at` is where the caret goes within `value` (default: after it).
  const insert = (from: number, to: number, value: string, at = value.length) => {
    const next = (text.slice(0, from) + value + text.slice(to)).slice(0, MAX_LENGTH);
    const pos = Math.min(from + at, next.length);
    setText(next);
    setCaret(pos);
    pendingCaret.current = pos;
  };
```

- [ ] **Step 3: Add `wrapSelection`**

After `pick`:

```tsx
  // Wraps the selection (or nothing) in a ``` block, naming the language when the guess is sure.
  const wrapSelection = () => {
    const el = box();
    const from = el?.selectionStart ?? text.length;
    const to = el?.selectionEnd ?? text.length;
    const selected = text.slice(from, to);
    const guess = selected ? guessLanguage(selected) : null;
    const atLineStart = from === 0 || text[from - 1] === "\n";
    const { value, caret: at } = wrapCodeBlock(selected, guess?.confident ? guess.lang : "", atLineStart);
    if (text.length - selected.length + value.length > MAX_LENGTH) return;
    insert(from, to, value, at);
  };
```

- [ ] **Step 4: Bind Ctrl/Cmd+E**

At the very top of the textarea's `onKeyDown`, before `if (listOpen)`:

```tsx
              if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "e") {
                e.preventDefault();
                wrapSelection();
                return;
              }
```

- [ ] **Step 5: Add the button**

Immediately before `<EmojiPicker`:

```tsx
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Code block" title="Code block (Ctrl+E)"
            onMouseDown={(e) => e.preventDefault()} onClick={wrapSelection}>
            <Code />
          </Button>
```

The `onMouseDown` `preventDefault` keeps focus and the selection in the textarea.

- [ ] **Step 6: Type-check**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Stage**

```bash
git add clients/web/src/app/Composer.tsx
```

---

### Task 7: Long paste becomes a snippet file

**Files:**
- Modify: `clients/web/src/hooks/use-uploads.ts`
- Modify: `clients/web/src/app/Composer.tsx` (`onPaste` and the attachment chips)

**Interfaces:**
- Consumes: `shouldSnippet`, `extensionForLanguage`, `snippetName` (Task 2); `guessLanguage` (Task 1); `insert(from, to, value, at?)` (Task 6).
- Produces, from `useUploads`: `addText(text: string, name: string): void`, `rename(key: string, name: string): void`, and `PendingFile.text?: string`.

The thresholds and naming are pinned by the Task 2 tests. The flow is verified by the e2e test in Task 8.

- [ ] **Step 1: Extend `useUploads`**

In `clients/web/src/hooks/use-uploads.ts`, change the React import to `import { useRef, useState } from "react";`. Then replace everything from `export interface PendingFile` to the end of the file with:

```ts
export interface PendingFile {
  key: string;
  name: string;
  size: number;
  type: string;
  text?: string; // a pasted snippet's text, so it can be renamed or pasted back
  attachment?: Attachment; // set once uploaded
  error?: string;
}

/** Files being attached to a message in `channelId`: each starts uploading as it is added.
 *  `onError` gets a message when files are refused (too many, or not matching `accept`). */
export function useUploads(channelId: string, { onError, accept }: {
  onError: (message: string) => void;
  accept?: { test: (file: File) => boolean; message: string };
}) {
  const [files, setFiles] = useState<PendingFile[]>([]);
  // The latest upload per file: a rename starts a new one, and the older result is dropped.
  const runs = useRef(new Map<string, string>());

  const update = (key: string, patch: Partial<PendingFile>) =>
    setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const upload = (key: string, file: File) => {
    const run = crypto.randomUUID();
    runs.current.set(key, run);
    const current = () => runs.current.get(key) === run;
    void (async () => {
      try {
        const { max_upload_bytes: max } = await instanceInfo();
        if (file.size > max) {
          if (current()) update(key, { error: `Over the ${formatBytes(max)} limit` });
          return;
        }
        const attachment = await client.upload(channelId, file, file.name);
        if (current()) update(key, { attachment });
      } catch (e) {
        if (current()) update(key, { error: errorText(e) });
      }
    })();
  };

  const add = (list: File[], text?: string) => {
    const refused = !!accept && list.some((f) => !accept.test(f));
    if (accept) list = list.filter((f) => accept.test(f));
    const room = MAX_FILES - files.length;
    const tooMany = list.length > room;
    // Both problems at once are reported together, so neither hides the other.
    if (refused || tooMany) {
      onError([refused && accept?.message, tooMany && `You can attach up to ${MAX_FILES} files`].filter(Boolean).join(" "));
    }
    for (const file of list.slice(0, Math.max(0, room))) {
      const key = crypto.randomUUID();
      setFiles((fs) => [...fs, { key, name: file.name, size: file.size, type: file.type, text }]);
      upload(key, file);
    }
  };

  return {
    files,
    add: (list: File[]) => add(list),
    /** Attaches pasted text as a file named `name`. */
    addText: (text: string, name: string) => add([new File([text], name, { type: "text/plain" })], text),
    /** Renames a pasted snippet by uploading its text again under the new name. */
    rename: (key: string, name: string) => {
      const f = files.find((x) => x.key === key);
      if (f?.text === undefined || name === f.name) return;
      update(key, { name, attachment: undefined, error: undefined });
      upload(key, new File([f.text], name, { type: "text/plain" }));
    },
    remove: (key: string) => {
      runs.current.delete(key);
      setFiles((fs) => fs.filter((f) => f.key !== key));
    },
    clear: () => {
      runs.current.clear();
      setFiles([]);
    },
    uploading: files.some((f) => !f.attachment && !f.error),
    ready: files.flatMap((f) => (f.attachment ? [f.attachment] : [])),
  };
}
```

Other callers use `add`, `remove`, `clear`, `files`, `uploading` and `ready`, all unchanged. Confirm with `grep -rn "useUploads" clients/web/src`.

- [ ] **Step 2: Turn long pastes into snippets**

In `Composer.tsx`, change the `@/lib/code` import to:

```tsx
import { extensionForLanguage, shouldSnippet, snippetName, wrapCodeBlock } from "@/lib/code";
```

Replace `onPaste` with:

```tsx
            onPaste={(e) => {
              const pasted = Array.from(e.clipboardData.files);
              if (canAttach && pasted.length > 0) {
                e.preventDefault();
                add(pasted);
                return;
              }
              const value = e.clipboardData.getData("text/plain");
              const el = e.currentTarget;
              const room = MAX_LENGTH - (text.length - (el.selectionEnd - el.selectionStart));
              if (!shouldSnippet(value, room, canAttach)) return;
              e.preventDefault();
              const guess = guessLanguage(value);
              uploads.addText(value, `snippet.${extensionForLanguage(guess?.confident ? guess.lang : undefined)}`);
            }}
```

- [ ] **Step 3: Snippet chip UI**

In the attachments `<ul>`, replace `<span>{f.name}</span>` with:

```tsx
                {f.text === undefined ? <span>{f.name}</span> : (
                  <Input key={f.name} defaultValue={f.name} aria-label="Snippet file name"
                    className="h-6 w-36 rounded-full border-0 bg-transparent px-1 py-0 text-sm shadow-none focus-visible:ring-1"
                    onBlur={(e) => uploads.rename(f.key, snippetName(e.target.value, f.name))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault(); // not a send
                        e.currentTarget.blur();
                      }
                    }} />
                )}
```

`key={f.name}` resets the input when `snippetName` normalises the name.

Between the status `<span>` and the remove button, add:

```tsx
                {f.text !== undefined && (
                  <Button variant="ghost" size="xs" disabled={text.length + f.text.length > MAX_LENGTH}
                    onClick={() => {
                      const el = box();
                      uploads.remove(f.key);
                      insert(el?.selectionStart ?? text.length, el?.selectionEnd ?? text.length, f.text!);
                    }}>
                    Paste as text
                  </Button>
                )}
```

- [ ] **Step 4: Type-check and run the unit tests**

Run: `pnpm typecheck && pnpm test`
Expected: no type errors; all unit tests pass.

- [ ] **Step 5: Stage**

```bash
git add clients/web/src/hooks/use-uploads.ts clients/web/src/app/Composer.tsx
```

---

### Task 8: End-to-end test

**Files:**
- Modify: `clients/web/e2e/chat.spec.ts` (append a new `test(...)` after "announcement, forum and gallery channels")

**Interfaces:**
- Consumes: the helpers `signIn` and `send` in `chat.spec.ts`, and the accessible names in Global Constraints.

- [ ] **Step 1: Write the test**

Append to `clients/web/e2e/chat.spec.ts`:

````ts
// Runs after the first test: alice and bob exist and #general is there.
test("code blocks, pasted snippets and code file previews", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  await signIn(alice, "alice");
  const bob = await (await browser.newContext()).newPage();
  await signIn(bob, "bob");
  await alice.getByRole("link", { name: "general" }).click();
  await bob.getByRole("link", { name: "general" }).click();
  const box = alice.getByLabel("Message", { exact: true });

  // A fenced block is highlighted for bob.
  await send(alice, "```ts\nconst answer: number = 42;\n```");
  const block = bob.locator(".code-block").filter({ hasText: "const answer" });
  await expect(block).toBeVisible();
  await expect(block.locator(".hljs-keyword").first()).toHaveText("const");
  await expect(block.getByRole("button", { name: "Copy code" })).toBeVisible();

  // The code button wraps the selection.
  await box.fill("let x = 1");
  await box.selectText();
  await alice.getByRole("button", { name: "Code block" }).click();
  await expect(box).toHaveValue(/^```\w*\nlet x = 1\n```$/);
  await box.fill("");

  // A long paste becomes a snippet file: renamed, sent, previewed, opened in full.
  const code = Array.from({ length: 60 }, (_, i) => `export const v${i}: number = ${i};`).join("\n");
  await box.evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, code);
  const name = alice.getByLabel("Snippet file name");
  await expect(name).toHaveValue(/^snippet\.\w+$/);
  await expect(box).toHaveValue("");
  await name.fill("values.ts");
  await name.press("Enter");
  await expect(alice.getByRole("list", { name: "Attachments" })).not.toContainText("Uploading");
  await alice.getByRole("button", { name: "Send" }).click();

  const preview = bob.locator(".code-block").filter({ hasText: "values.ts" });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("v14");
  await expect(preview).not.toContainText("v15");
  await bob.getByRole("button", { name: "Show all 60 lines" }).click();
  await expect(bob.getByRole("dialog", { name: "values.ts" })).toContainText("v59");
  await bob.keyboard.press("Escape");

  // An uploaded .go file previews the same way.
  await alice.locator('input[type="file"]').setInputFiles({
    name: "main.go", mimeType: "text/plain", buffer: Buffer.from('package main\n\nfunc main() {\n\tprintln("hi")\n}\n'),
  });
  await alice.getByRole("button", { name: "Send" }).click();
  await expect(bob.locator(".code-block").filter({ hasText: "main.go" }).locator(".hljs-keyword").first()).toHaveText("package");
});
````

- [ ] **Step 2: Run the e2e suite**

The suite needs a fresh full stack. See the memory note "Local dev environment":
- Use `down -v`, then `up -d --build --wait` on project `datrope-e2e`, with the local-ports override if `datrope-dev-livekit` is running.
- Ask the user before starting Docker Desktop.

Run (from `clients/web`): `pnpm e2e`
Expected: all tests pass, including "code blocks, pasted snippets and code file previews". The new test depends on the first test having created alice and bob, so run the whole file.

- [ ] **Step 3: Stage**

```bash
git add clients/web/e2e/chat.spec.ts
```

---

## Final verification

- [ ] From `clients/web`, run `pnpm typecheck`, `pnpm test` and `pnpm build`. Expected: no type errors, all tests pass, and the build succeeds.
- [ ] Check that the build emits lowlight as its own chunk, so the main chunk does not grow by the full highlight.js size. Run `ls dist/assets` and look for a separate `lowlight-setup-*.js`.
- [ ] Run `pnpm e2e`. Expected: all tests pass.
- [ ] Run `git status`. Expected: everything is staged and nothing is committed.
