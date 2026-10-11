# Code snippets and text-file previews

Date: 2026-10-11
Status: approved design, pending plan

## Goal

Make code readable in chat:

- **A.** Fenced code blocks in messages get syntax highlighting.
- **B.** The composer can wrap text in a code block (button + shortcut).
- **C.** Long pastes become a snippet file attachment instead of a wall of text.
- Uploaded text/code files preview inline as highlighted code, with a full view in a dialog.

Web client only (`clients/web`). No server changes.

## Current state

- Messages render through `react-markdown` + `remark-gfm` in `src/chat/Markdown.tsx`. Code blocks
  are bare `<pre><code class="language-x">`, styled only by `.chat-md pre/code` in `src/styles.css`.
- No highlighter in `package.json`.
- Non-image, non-media attachments render as a download chip in `Attachments`
  (`src/app/MessageList.tsx`).
- The server sniffs content type from bytes; text files are stored as `text/plain; charset=utf-8`
  and served as `application/octet-stream` with `Content-Disposition: attachment`. `fetch` still
  reads the body, so no server change is needed to preview them.
- Unclaimed uploads (never attached to a sent message) are removed by the server's hourly cleanup.

## Decisions

- **Highlighter: highlight.js via `lowlight`.** Synchronous, emits HAST (rendered as React
  elements, no `dangerouslySetInnerHTML`), and has `highlightAuto` for guessing the language of a
  paste. Register a curated set of ~30 common languages (ts/js/tsx/jsx, go, python, rust, java,
  kotlin, c, cpp, csharp, json, yaml, toml, sql, bash/shell, powershell, html/xml, css, scss,
  markdown, dockerfile, diff, ini, lua, php, ruby, swift, plaintext). Loaded lazily in its own chunk.
- **Colors** are new `--syntax-*` CSS variables in `src/styles.css` (`:root` + `@theme inline`),
  mapped from highlight.js classes (`hljs-keyword`, `hljs-string`, …). No hardcoded colors; dark only.
- Rejected: Shiki (heavier, async, no auto-detect), Prism (no auto-detect, fewer languages).

## Components

### `CodeBlock` — `src/components/code-block.tsx`

- Props: `code: string`, `lang?: string`, `lineNumbers?: boolean`, `maxLines?: number`.
- Highlights with lowlight when `lang` is registered; otherwise renders plaintext.
- Header: language label + copy button (shadcn `Button`, `Tooltip`).
- Until the lazy lowlight chunk loads, renders the plain text (no layout shift).

### Markdown code blocks (A)

- `Markdown.tsx` `components` map gets a `pre` renderer that pulls the child `code`'s
  `language-x` class and text and renders `CodeBlock`. Inline `code` is unchanged.
- Inline mode (channel topics) is unaffected.

### `CodeFileAttachment` — in `src/app/attachments/`

- Used by `Attachments` for attachments with `content_type` starting `text/` and
  `size <= 1 MB`. Everything else keeps the current behaviour.
- Fetches the attachment URL as text. Language comes from the filename extension
  (map in a small `languageForFilename()` helper); unknown → plaintext.
- Shows a header (filename, language, size), the first 15 lines highlighted, and buttons:
  **Show all N lines** (only when there are more), **Copy**, **Download**.
- **Show all** opens a shadcn `Dialog` with the full file, line numbers, and scrolling.
- Loading: header plus a skeleton. Fetch failure: falls back to the current download chip.

### Code-block button (B) — `Composer.tsx`

- A `Code` icon button next to the emoji button, plus **Ctrl/Cmd+E** (as on GitHub; Ctrl+Shift+C is taken by the browser inspector).
- With a selection, wraps it as ```` ```<lang>\n…\n``` ````. Without one, inserts an empty block
  and places the cursor inside.
- `<lang>` comes from `guessLanguage()` and is only filled in when the guess is confident.
- Respects `MAX_LENGTH`; if wrapping would exceed it, nothing changes.

### Long paste becomes a snippet (C) — `Composer.tsx` + `use-uploads.ts`

- In `onPaste`, when the pasted text has more than 1500 characters, more than 40 lines, or would
  push the message over `MAX_LENGTH`:
  1. Prevent the default paste.
  2. Guess the language and name the file `snippet.<ext>` (fallback `snippet.txt`).
  3. Wrap the text in a `File` and pass it to `uploads.add`.
- Pastes that include files keep the existing file-paste path.
- `PendingFile` gains `text?: string`, the original pasted text.
- Snippet chips get:
  - **Paste as text** (undo): removes the chip and inserts the text at the cursor. Disabled when
    the text would not fit within `MAX_LENGTH`.
  - **Editable filename**: renaming re-uploads the text under the new name (new attachment). The
    old unclaimed attachment is left for server cleanup. The language follows the extension.
- The 10-file limit applies; when it is full the usual error is shown.

### Shared helpers — `src/lib/code.ts`

- `guessLanguage(text): { lang: string; confident: boolean }`: uses `highlightAuto` over the
  registered set; `confident` when its relevance is above a threshold that the tests tune.
- `languageForFilename(name): string | undefined` and `extensionForLanguage(lang): string`.
- `shouldSnippet(text, currentLength, maxLength): boolean`: implements the thresholds above.

## Error handling

- Unknown or unregistered language → plaintext, never an error.
- Preview fetch fails, or the file is over 1 MB → the existing download chip.
- Non-UTF-8 text decodes with replacement characters; this is acceptable.
- Upload errors on a snippet chip use the existing chip error state.

## Testing

- **Vitest:**
  - `shouldSnippet` thresholds.
  - `guessLanguage` on samples (ts, go, python, json, plain prose → not confident).
  - `languageForFilename`.
  - `CodeBlock` renders tokens and falls back to plaintext.
  - `CodeFileAttachment` truncates to 15 lines and falls back to the chip on fetch error.
- **Playwright e2e:**
  1. Send a ```` ```ts ```` block and see highlighted tokens.
  2. Paste long text, see a snippet chip, send it, and see the inline preview.
  3. **Show all** opens the dialog with the full file.
  4. The code button wraps the selection.
- Keep accessible names stable (button labels above) for role and label selectors.

## Out of scope

- Server-side changes, including serving text inline or a rename endpoint.
- Highlighting in the welcome page renderer (`WelcomeMarkdown.tsx`).
- A language picker UI; line-range links; editing snippets after sending.
