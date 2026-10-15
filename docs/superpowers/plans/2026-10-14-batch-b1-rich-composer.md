# B1 Rich composer (emoji shown inline in input fields) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emoji show as images or glyphs while typing, instead of as `:code:`. This applies to:
- the message composer;
- the message edit box;
- the status, custom status and About me fields;
- the channel name fields.

**Architecture:**
- A small custom contenteditable, `RichInput`, replaces the textarea and input elements. It has no editor library.
- The text model stays a plain string, exactly what is sent today:
  - custom emoji stay as `:name:`;
  - unicode shortcodes become the unicode character the moment their closing `:` is typed.
- The DOM is a projection of that string: text nodes, plus one `<img data-emoji=":name:">` atom per known custom emoji, plus a filler `<br>` after a trailing newline.
- `RichInput` exposes a textarea-like handle (`selection()`, `setSelection()`, `focus()`). The `Composer`'s existing insert, autocomplete, code-block, paste and command logic keep working on string offsets, unchanged.
- The server does not change.

**Tech Stack:** React 18 (no ref forwarding in shadcn components, so we write `forwardRef` ourselves), Tailwind v4, zustand store (`useApp`), Vitest (node, no DOM), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-14-multi-features-design.md`, section B1. The user chose "Rich contenteditable" over the lighter options.

## Global Constraints

- Never commit (AGENTS.md §5). Stage only.
- Never hardcode colors. Use token utilities only.
- The app is dark-only.
- **Keep accessible names stable.** The composer keeps `aria-label={label}` ("Message" by default) and `role="combobox"`. The edit box keeps "Edit message". Profile and channel fields keep their visible labels, linked with `aria-labelledby`.
- Vitest runs in node, with no DOM. All model logic lives in `chat/rich-text.ts` as pure functions, tested there. DOM glue is checked through e2e and in the browser.
- The serialized string must be byte-identical to what the textarea produced for the same keystrokes. The only intended difference is that a typed unicode `:shortcode:` becomes its character.
- `rtk` is not on subagents' PATH. Run plain `pnpm exec …` from `clients/web`.
- Undo/redo is best effort. Rebuilding the DOM for an atom resets the native undo stack. That is accepted by the spec.

## Review Focus

1. **IME composition** (Japanese, Chinese, Korean, Android keyboards that compose every word). Nothing may be rebuilt, converted or sent while `isComposing`. Enter during composition confirms the text and does not send. Covered by Task 2: the `compositionend` path and `isComposing` guards.
2. **Pasting rich HTML** (from a web page or Word). Only plain text arrives, with no `<b>`, `<div>` or styles, and newlines are kept. Covered by Task 2: `serialize` tests for stray elements, plus the paste handler.
3. **A newline at the very end** (Shift+Enter on the last line). The caret moves to the new empty line, and the serialized value ends with exactly one `\n`. Covered by Task 1: the filler-`<br>` tests.
4. **Caret position around emoji atoms** after an insert from the picker, from autocomplete, or after typing `:parrot:`. The caret ends right after the inserted emoji, never inside the atom or at the start. Covered by Task 1: the `locate` and `offsetOf` tests.
5. **Existing e2e flows** (`fill`, `pressSequentially`, autocomplete with Enter, `/shrug`, Escape). They keep passing, with `toHaveValue` on the Message box replaced by `toHaveText`. Covered by Task 3.

---

### Task 1: The text model, a pure module

**Files:**
- Create: `clients/web/src/chat/rich-text.ts`
- Test: `clients/web/src/chat/rich-text.test.ts`

**Interfaces:**
- Produces:
  - `type Seg = { kind: "text"; text: string } | { kind: "emoji"; code: string }`, where `code` is the exact text, e.g. `:Parrot:`.
  - `segments(value: string, isCustom: (lowerName: string) => boolean): Seg[]`. It merges adjacent text and never emits an empty text segment.
  - `segLength(s: Seg): number`
  - `locate(segs: Seg[], offset: number): { seg: number; inner: number }`. For a text segment, `inner` is the character offset. For an emoji segment, it is 0 (before) or 1 (after). Offsets inside an emoji snap to after it. Without segments it returns `{ seg: -1, inner: 0 }`.
  - `offsetOf(segs: Seg[], seg: number, inner: number): number`
  - `convertShortcodeAt(value: string, caret: number, shortcodes: Map<string, string> | null): { value: string; caret: number }`. It replaces a `:code:` that ends exactly at `caret`, if the code is a unicode shortcode.
  - `interface MiniNode { nodeType: number; nodeName: string; data?: string; childNodes: ArrayLike<MiniNode>; getAttribute?(name: string): string | null }` and `serialize(root: MiniNode): string`.
  - `spliceText(value: string, start: number, end: number, insert: string, max: number): { value: string; caret: number }`

- [ ] **Step 1: Write the failing tests**

`clients/web/src/chat/rich-text.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { convertShortcodeAt, locate, offsetOf, segments, serialize, spliceText, type MiniNode } from "./rich-text";

const custom = (n: string) => n === "parrot" || n === "blob_ok";

describe("segments", () => {
  it("splits known custom emoji into atoms and keeps the rest as text", () =>
    expect(segments("hi :Parrot: and :nope: :blob_ok:", custom)).toEqual([
      { kind: "text", text: "hi " }, { kind: "emoji", code: ":Parrot:" }, { kind: "text", text: " and :nope: " }, { kind: "emoji", code: ":blob_ok:" },
    ]));
  it("handles adjacent atoms and empty input", () => {
    expect(segments(":parrot::parrot:", custom)).toEqual([{ kind: "emoji", code: ":parrot:" }, { kind: "emoji", code: ":parrot:" }]);
    expect(segments("", custom)).toEqual([]);
  });
});

describe("locate / offsetOf", () => {
  const segs = segments("ab:parrot:cd", custom); // text "ab" (0-2), emoji (2-10), text "cd" (10-12)
  it("maps offsets into segments", () => {
    expect(locate(segs, 0)).toEqual({ seg: 0, inner: 0 });
    expect(locate(segs, 2)).toEqual({ seg: 0, inner: 2 }); // end of text wins over before-emoji
    expect(locate(segs, 10)).toEqual({ seg: 2, inner: 0 });
    expect(locate(segs, 12)).toEqual({ seg: 2, inner: 2 });
  });
  it("snaps an offset inside an emoji to after it", () => expect(locate(segs, 5)).toEqual({ seg: 1, inner: 1 }));
  it("finds the spot after a trailing emoji", () => expect(locate(segments("x:parrot:", custom), 9)).toEqual({ seg: 1, inner: 1 }));
  it("round-trips", () => {
    for (const o of [0, 1, 2, 10, 11, 12]) {
      const { seg, inner } = locate(segs, o);
      expect(offsetOf(segs, seg, inner)).toBe(o);
    }
  });
  it("has no segment for empty text", () => expect(locate([], 0)).toEqual({ seg: -1, inner: 0 }));
});

describe("convertShortcodeAt", () => {
  const codes = new Map([["smile", "😄"], ["+1", "👍"]]);
  it("replaces a just-closed unicode shortcode", () =>
    expect(convertShortcodeAt("hi :smile: there", 10, codes)).toEqual({ value: "hi 😄 there", caret: 3 + "😄".length }));
  it("ignores shortcodes not at the caret, unknown codes and custom ones", () => {
    expect(convertShortcodeAt(":smile: x", 9, codes)).toEqual({ value: ":smile: x", caret: 9 });
    expect(convertShortcodeAt(":parrot:", 8, codes)).toEqual({ value: ":parrot:", caret: 8 });
    expect(convertShortcodeAt(":smile:", 7, null)).toEqual({ value: ":smile:", caret: 7 });
  });
  it("is case-insensitive", () => expect(convertShortcodeAt(":Smile:", 7, codes).value).toBe("😄"));
  it("leaves inline code alone", () => expect(convertShortcodeAt("`:smile:", 8, codes).value).toBe("`:smile:"));
});

const t = (data: string): MiniNode => ({ nodeType: 3, nodeName: "#text", data, childNodes: [] });
const el = (name: string, kids: MiniNode[] = [], attrs: Record<string, string> = {}): MiniNode =>
  ({ nodeType: 1, nodeName: name.toUpperCase(), childNodes: kids, getAttribute: (n) => attrs[n] ?? null });

describe("serialize", () => {
  it("reads text, atoms and line breaks", () =>
    expect(serialize(el("div", [t("a "), el("img", [], { "data-emoji": ":parrot:" }), t("\nb"), el("br", [], { "data-filler": "" })]))).toBe("a :parrot:\nb"));
  it("turns a stray <br> into a newline and block elements into lines", () =>
    expect(serialize(el("div", [t("a"), el("br"), t("b"), el("div", [t("c")]), el("p", [t("d")])]))).toBe("a\nb\nc\nd"));
  it("keeps the text of stray inline elements", () =>
    expect(serialize(el("div", [el("b", [t("bold")]), el("span", [t(" x")])]))).toBe("bold x"));
  it("ignores images that are not our emoji", () => expect(serialize(el("div", [el("img"), t("x")]))).toBe("x"));
  it("ignores a browser's placeholder <br> at the very end", () => {
    expect(serialize(el("div", [el("br")]))).toBe("");
    expect(serialize(el("div", [t("a"), el("br")]))).toBe("a");
  });
});

describe("spliceText", () => {
  it("replaces the selection and puts the caret after the insert", () =>
    expect(spliceText("hello world", 6, 11, "there", 4000)).toEqual({ value: "hello there", caret: 11 }));
  it("cuts to the length limit", () => expect(spliceText("abc", 3, 3, "defg", 5)).toEqual({ value: "abcde", caret: 5 }));
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run src/chat/rich-text.test.ts`
Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement**

`clients/web/src/chat/rich-text.ts`:

```ts
// The rich input's text model: the plain string the composer sends (custom emoji as :name:), and its projection into
// segments (text runs and emoji atoms) that the contenteditable shows. Pure, so it is tested without a DOM.

export type Seg = { kind: "text"; text: string } | { kind: "emoji"; code: string };

const CODE = /:([A-Za-z0-9_+-]{2,32}):/g;

/** Text and custom-emoji atoms; `isCustom` gets the lower-cased name. Unknown :codes: stay text. */
export function segments(value: string, isCustom: (lowerName: string) => boolean): Seg[] {
  const out: Seg[] = [];
  const pushText = (s: string) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (last?.kind === "text") last.text += s;
    else out.push({ kind: "text", text: s });
  };
  let at = 0;
  for (const m of value.matchAll(CODE)) {
    if (!isCustom(m[1]!.toLowerCase())) continue;
    pushText(value.slice(at, m.index));
    out.push({ kind: "emoji", code: m[0] });
    at = m.index + m[0].length;
  }
  pushText(value.slice(at));
  return out;
}

export const segLength = (s: Seg) => (s.kind === "text" ? s.text.length : s.code.length);

/** Where string offset `offset` falls: a text run and a character in it, or before (0) or after (1) an emoji atom. */
export function locate(segs: Seg[], offset: number): { seg: number; inner: number } {
  if (segs.length === 0) return { seg: -1, inner: 0 };
  let start = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const end = start + segLength(s);
    if (s.kind === "text" && offset <= end) return { seg: i, inner: Math.max(0, offset - start) };
    if (s.kind === "emoji") {
      if (offset <= start) return { seg: i, inner: 0 };
      if (offset < end || (offset === end && i === segs.length - 1)) return { seg: i, inner: 1 };
    }
    start = end;
  }
  const last = segs.length - 1;
  return { seg: last, inner: segs[last]!.kind === "text" ? segLength(segs[last]!) : 1 };
}

export function offsetOf(segs: Seg[], seg: number, inner: number): number {
  let start = 0;
  for (let i = 0; i < seg; i++) start += segLength(segs[i]!);
  const s = segs[seg];
  if (!s) return start;
  return start + (s.kind === "text" ? inner : inner ? s.code.length : 0);
}

/** Turns a unicode :shortcode: that ends at the caret (its closing ":" just typed) into the emoji itself. */
export function convertShortcodeAt(value: string, caret: number, shortcodes: Map<string, string> | null): { value: string; caret: number } {
  if (!shortcodes) return { value, caret };
  const before = value.slice(0, caret);
  const line = before.slice(before.lastIndexOf("\n") + 1);
  if ((line.match(/`/g)?.length ?? 0) % 2 === 1) return { value, caret }; // inside inline code
  const m = /:([A-Za-z0-9_+-]{2,32}):$/.exec(before);
  const emoji = m && shortcodes.get(m[1]!.toLowerCase());
  if (!m || !emoji) return { value, caret };
  const from = caret - m[0].length;
  return { value: value.slice(0, from) + emoji + value.slice(caret), caret: from + emoji.length };
}

/** The bits of a DOM node `serialize` reads (so tests can pass plain objects). */
export interface MiniNode {
  nodeType: number;
  nodeName: string;
  data?: string;
  childNodes: ArrayLike<MiniNode>;
  getAttribute?(name: string): string | null;
}

const BLOCK = new Set(["DIV", "P", "LI"]);

/** The plain string a contenteditable's content stands for: emoji atoms as their :code:, line breaks as \n.
 *  Our trailing filler <br>, and the placeholder <br> a browser leaves as the root's last child, are not text. */
export function serialize(root: MiniNode): string {
  let out = "";
  const walk = (n: MiniNode, isRoot: boolean) => {
    const kids = n.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i]!;
      if (c.nodeType === 3) out += c.data ?? "";
      else if (c.nodeType !== 1) continue;
      else if (c.nodeName === "IMG") out += c.getAttribute?.("data-emoji") ?? "";
      else if (c.nodeName === "BR") {
        const filler = c.getAttribute?.("data-filler") != null;
        const trailing = isRoot && i === kids.length - 1;
        if (!filler && !trailing) out += "\n";
      } else {
        if (BLOCK.has(c.nodeName) && out && !out.endsWith("\n")) out += "\n";
        walk(c, false);
      }
    }
  };
  walk(root, true);
  return out;
}

/** `value` with [start, end) replaced by `insert`, cut to `max`; the caret goes after the insert. */
export function spliceText(value: string, start: number, end: number, insert: string, max: number): { value: string; caret: number } {
  const next = (value.slice(0, start) + insert + value.slice(end)).slice(0, max);
  return { value: next, caret: Math.min(start + insert.length, next.length) };
}
```

A non-filler `<br>` that is the root's last child is the placeholder some browsers (Firefox) leave in an emptied contenteditable, so it is not a newline. Our own trailing newline is always "\n" text plus the filler `<br>`.

- [ ] **Step 4: Run them and watch them pass**

Run: `pnpm exec vitest run src/chat/rich-text.test.ts`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add clients/web/src/chat/rich-text.ts clients/web/src/chat/rich-text.test.ts
```

---

### Task 2: The `RichInput` component

**Files:**
- Create: `clients/web/src/chat/RichInput.tsx`
- Modify: `clients/web/src/styles.css` (one placeholder rule)

**Interfaces:**
- Consumes (Task 1): `segments`, `serialize`, `locate`, `convertShortcodeAt`, `spliceText`.
- Produces:

```ts
export interface RichInputHandle {
  el: HTMLDivElement | null;
  focus(): void;
  selection(): { start: number; end: number }; // string offsets; the end of the text when not focused
  setSelection(start: number, end?: number): void;
}
export type RichInputProps = {
  value: string;
  onChange: (value: string, caret: number) => void;
  onSelect?: (caret: number) => void;
  /** Called first; if it calls preventDefault the input does nothing else. Otherwise the input pastes plain text. */
  onPaste?: (e: React.ClipboardEvent<HTMLDivElement>, sel: { start: number; end: number }) => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  placeholder?: string;
  maxLength?: number;
  singleLine?: boolean; // Enter does nothing (the caller may submit); newlines are stripped
  autoFocus?: boolean; // focuses with the caret at the end
  variant?: "bare" | "input"; // "input" looks like components/ui/input.tsx
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "onChange" | "onSelect" | "onPaste" | "onKeyDown" | "contentEditable" | "children">;
export const RichInput: React.ForwardRefExoticComponent<RichInputProps & React.RefAttributes<RichInputHandle>>;
```

There is no unit test for this file, because Vitest has no DOM. It is covered by the existing e2e and by Task 3's browser check. Keep every decision that can be pure in `rich-text.ts`.

- [ ] **Step 1: Implement**

`clients/web/src/chat/RichInput.tsx`:

```tsx
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import { useApp } from "@/session";
import { sizedImage } from "@/lib/sized-image";
import { cn } from "@/lib/utils";
import { useEmojiData } from "./emoji-data";
import { convertShortcodeAt, segments, serialize, spliceText } from "./rich-text";

// RichInputHandle and RichInputProps exactly as in the plan's Interfaces block.

/** Same look as components/ui/input.tsx, for single-line fields. Copy the class list from there when it changes. */
const INPUT_LOOK = "<copy the cn(...) string literal classes from components/ui/input.tsx, minus file: and aria-invalid: variants>";

/** The string offset of a DOM point inside `root`: the serialized length of everything before it. */
function offsetAt(root: HTMLElement, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(node, offset);
  const box = document.createElement("div");
  box.append(r.cloneContents());
  return serialize(box);
}

/** The DOM point for string offset `want`: in a text node, or between root children around atoms. */
function pointAt(root: HTMLElement, want: number): [Node, number] {
  let acc = 0;
  const kids = Array.from(root.childNodes);
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i]!;
    if (c.nodeType === Node.TEXT_NODE) {
      const len = (c as Text).data.length;
      if (want <= acc + len) return [c, want - acc];
      acc += len;
    } else {
      const el = c as HTMLElement;
      if (el.dataset.filler !== undefined) return [root, i];
      const len = serialize({ nodeType: 1, nodeName: "DIV", childNodes: [el] } as never).length;
      if (want <= acc) return [root, i];
      acc += len;
    }
  }
  const last = kids[kids.length - 1] as HTMLElement | undefined;
  return [root, last?.dataset?.filler !== undefined ? kids.length - 1 : kids.length];
}

export const RichInput = forwardRef<RichInputHandle, RichInputProps>(function RichInput(
  { value, onChange, onSelect, onPaste, onKeyDown, placeholder, maxLength = Infinity, singleLine = false, autoFocus, variant = "bare", className, ...rest },
  ref,
) {
  const root = useRef<HTMLDivElement>(null);
  const pending = useRef<number | null>(null); // caret to restore after the next render
  const composing = useRef(false);
  const emoji = useApp((s) => s.emoji);
  const data = useEmojiData();
  const custom = useMemo(() => new Map(Object.values(emoji).map((e) => [e.name.toLowerCase(), sizedImage(e.url, 22)])), [emoji]);

  const selection = useCallback((): { start: number; end: number } => {
    const el = root.current;
    const sel = typeof window === "undefined" ? null : window.getSelection();
    if (!el || !sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return { start: value.length, end: value.length };
    const r = sel.getRangeAt(0);
    const a = offsetAt(el, r.startContainer, r.startOffset);
    const b = offsetAt(el, r.endContainer, r.endOffset);
    return { start: Math.min(a, b), end: Math.max(a, b) };
  }, [value]);

  const setSelection = useCallback((start: number, end = start) => {
    const el = root.current;
    if (!el) return;
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(...pointAt(el, start));
    r.setEnd(...pointAt(el, end));
    sel?.removeAllRanges();
    sel?.addRange(r);
  }, []);

  useImperativeHandle(ref, () => ({ el: root.current, focus: () => root.current?.focus(), selection, setSelection }), [selection, setSelection]);

  // Project the string into the DOM when the DOM does not already say the same thing (an outside change, or a
  // :code: that just became an atom). Never during IME composition.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || composing.current) return;
    const segs = segments(value, (n) => custom.has(n));
    const atoms = segs.filter((s) => s.kind === "emoji").length;
    if (serialize(el) === value && el.querySelectorAll("img[data-emoji]").length === atoms) {
      if (pending.current !== null && document.activeElement === el) setSelection(pending.current);
      pending.current = null;
      return;
    }
    const caret = pending.current ?? (document.activeElement === el ? selection().start : null);
    el.replaceChildren(...segs.map((s) => {
      if (s.kind === "text") return document.createTextNode(s.text);
      const img = document.createElement("img");
      const src = custom.get(s.code.slice(1, -1).toLowerCase())!;
      img.src = src.src;
      if (src.srcSet) img.srcset = src.srcSet;
      img.alt = s.code;
      img.className = "emoji inline-block size-[1.375em] align-text-bottom";
      img.draggable = false;
      img.contentEditable = "false";
      img.setAttribute("data-emoji", s.code);
      return img;
    }));
    if (value.endsWith("\n")) {
      const br = document.createElement("br");
      br.setAttribute("data-filler", "");
      el.append(br);
    }
    pending.current = null;
    if (caret !== null && document.activeElement === el) setSelection(Math.min(caret, value.length));
  }, [value, custom, selection, setSelection]);

  useEffect(() => {
    if (!autoFocus) return;
    root.current?.focus();
    setSelection(value.length);
    // Only on mount, like the textarea's autoFocus plus the old onFocus "caret to end".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Applies a new string and caret, with the length limit, single-line rule and :shortcode: conversion. */
  const commit = (next: string, caret: number) => {
    let v = singleLine ? next.replace(/\n/g, " ") : next;
    if (v.length > maxLength) v = v.slice(0, maxLength);
    const c = convertShortcodeAt(v, Math.min(caret, v.length), data?.byShortcode ?? null);
    pending.current = c.caret;
    onChange(c.value, c.caret);
  };

  const insertText = (text: string) => {
    const { start, end } = selection();
    const s = spliceText(value, start, end, text, maxLength);
    commit(s.value, s.caret);
  };

  // Structural edits the browser would do its own way (new <div>s, bold, drops) go through the string instead.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const before = (e: InputEvent) => {
      if (e.isComposing) return;
      if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") {
        e.preventDefault();
        if (!singleLine) insertText("\n");
      } else if (e.inputType.startsWith("format") || e.inputType === "insertFromDrop" || e.inputType === "insertFromPaste") {
        e.preventDefault(); // paste is handled in onPaste; drops of files go to the form
      }
    };
    el.addEventListener("beforeinput", before);
    return () => el.removeEventListener("beforeinput", before);
  });

  // Caret moves (clicks, arrow keys) for autocomplete.
  useEffect(() => {
    if (!onSelect) return;
    const on = () => {
      if (document.activeElement === root.current) onSelect(selection().start);
    };
    document.addEventListener("selectionchange", on);
    return () => document.removeEventListener("selectionchange", on);
  }, [onSelect, selection]);

  const empty = value === "";
  return (
    <div
      {...rest}
      ref={root}
      contentEditable="true"
      suppressContentEditableWarning
      spellCheck
      aria-multiline={!singleLine}
      aria-placeholder={placeholder}
      data-placeholder={placeholder}
      data-empty={empty || undefined}
      tabIndex={0}
      className={cn("rich-input whitespace-pre-wrap break-words outline-none", singleLine && "overflow-hidden whitespace-nowrap", variant === "input" && INPUT_LOOK, className)}
      onInput={() => {
        if (composing.current || !root.current) return;
        commit(serialize(root.current), selection().start);
      }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => {
        composing.current = false;
        if (root.current) commit(serialize(root.current), selection().start);
      }}
      onPaste={(e) => {
        const sel = selection();
        onPaste?.(e, sel);
        if (e.defaultPrevented) return;
        e.preventDefault();
        insertText(e.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n"));
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length > 0) return; // the form takes files
        e.preventDefault();
        insertText(e.dataTransfer.getData("text/plain"));
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (!e.defaultPrevented && singleLine && e.key === "Enter") {
          e.preventDefault();
          (e.currentTarget.closest("form") as HTMLFormElement | null)?.requestSubmit();
        }
      }}
    />
  );
});
```

Rulings for the implementer:
- `INPUT_LOOK`: open `components/ui/input.tsx` and copy its base class list (the first string inside `cn(`) into this constant as a literal. Leave out `file:*` variants. Keep the focus-visible ring classes.
- The `useEffect` for `beforeinput` has no dependency array on purpose, so it always closes over the latest `value`. That is cheap: one listener swap per render.
- If `react-hooks/exhaustive-deps` flags anything else, fix it properly rather than disabling the rule. The only accepted disable is the mount-only autofocus.
- In single-line mode, Enter submits the enclosing form when the caller did not handle it. That matches what an `<input>` inside a form does.

Add to `clients/web/src/styles.css`, next to the other component rules:

```css
/* RichInput's placeholder: an empty contenteditable shows it like a textarea would. */
.rich-input[data-empty]::before {
  content: attr(data-placeholder);
  color: var(--muted-foreground);
  pointer-events: none;
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `pnpm exec tsc -p tsconfig.json && pnpm exec eslint src/chat/RichInput.tsx src/chat/rich-text.ts`
Expected: no errors.

- [ ] **Step 3: Stage**

```bash
git add clients/web/src/chat/RichInput.tsx clients/web/src/styles.css
```

---

### Task 3: The composer uses `RichInput`

**Files:**
- Modify: `clients/web/src/app/Composer.tsx` (`box()`, `selLen()`, the caret effect, the reply focus, `wrapSelection`, "Paste as text", the emoji picker insert, and the `Textarea` itself at ~:261)
- Modify: `clients/web/src/app/MessageList.tsx:95-101` (the `composer()` helper)
- Modify: `clients/web/src/components/skip-links.tsx:18`, `clients/web/src/hooks/use-shortcuts.ts:83` (selectors)
- Modify: `clients/web/e2e/chat.spec.ts:227,274,278,283` (`toHaveValue` → `toHaveText` on the Message box)

**Interfaces:**
- Consumes: `RichInput` and `RichInputHandle` (Task 2).
- Produces: the composer element `[data-composer]`, with `role="combobox"` and `aria-label={label}`.

- [ ] **Step 1: Replace the textarea plumbing in `Composer.tsx`**

1. Imports: remove `Textarea` if nothing else uses it, and add `import { RichInput, type RichInputHandle } from "@/chat/RichInput";`.
2. Replace

```ts
  const box = () => form.current?.querySelector("textarea");
  const selLen = () => { const el = box(); return el ? el.selectionEnd - el.selectionStart : 0; };
```

with

```ts
  const input = useRef<RichInputHandle>(null);
  const sel = () => input.current?.selection() ?? { start: text.length, end: text.length };
  const selLen = () => { const s = sel(); return s.end - s.start; };
```

3. In the caret `useLayoutEffect`, replace `box()?.focus(); box()?.setSelectionRange(at, at);` with `input.current?.focus(); input.current?.setSelection(at);`.
4. In the reply effect, use `input.current?.focus()` instead of `box()?.focus()`.
5. In `wrapSelection`, replace the first three lines with `const { start: from, end: to } = sel();`.
6. In "Paste as text": `const s = sel(); uploads.remove(f.key); insert(s.start, s.end, f.text!);`.
7. In the dropdown's "Code block" item: `input.current?.focus(); wrapSelection();`.
8. In the `EmojiPicker`, use `onPick={(v) => { const s = sel(); insert(s.start, s.end, emojiText(v)); }}` and `onCloseAutoFocus={(e) => { e.preventDefault(); input.current?.focus(); }}`.

- [ ] **Step 2: Replace the `<Textarea …>` element**

Replace it with:

```tsx
          <RichInput ref={input} data-composer=""
            className="max-h-[40vh] min-h-0 flex-1 overflow-y-auto px-1 py-1.5 text-title max-md:min-h-[44px] max-md:py-2.5"
            value={text} placeholder={placeholder} aria-label={label} maxLength={MAX_LENGTH}
            enterKeyHint={isTouchOnly() ? "enter" : undefined}
            role="combobox" aria-expanded={listOpen} aria-autocomplete="list" aria-controls={listOpen ? listId : undefined}
            aria-activedescendant={listOpen ? `${listId}-${activeIndex}` : undefined}
            onChange={(v, c) => {
              setText(v);
              setCaret(c);
              client.typing(channelId).catch(() => undefined);
            }}
            onSelect={setCaret}
            onPaste={(e, s) => {
              const pasted = Array.from(e.clipboardData.files);
              if (canAttach && pasted.length > 0) {
                e.preventDefault();
                add(pasted);
                return;
              }
              const value = e.clipboardData.getData("text/plain");
              const room = MAX_LENGTH - (text.length - (s.end - s.start));
              if (!shouldSnippet(value, room, canAttach)) return; // RichInput pastes it as plain text
              if (files.length >= MAX_FILES && value.length <= room) return;
              e.preventDefault();
              if (s.end > s.start) insert(s.start, s.end, "");
              const guess = guessLanguage(value);
              uploads.addText(value, `snippet.${extensionForLanguage(guess?.confident ? guess.lang : undefined)}`);
            }}
            onKeyDown={/* the existing handler, unchanged: e is now React.KeyboardEvent<HTMLDivElement> */} />
```

Keep the existing `onKeyDown` body exactly as it is. It only uses `e.key`, its modifiers, `e.nativeEvent.isComposing`, `e.defaultPrevented` and `preventDefault`. For Shift+Enter or a touch newline, `enterAction` returns something other than "send", the event is not prevented, and `RichInput`'s `beforeinput` turns it into "\n".

`enterKeyHint` passes through `...rest` to the div. It is valid on contenteditable elements.

- [ ] **Step 3: Update the selectors that looked for the textarea**

In `MessageList.tsx`, the `composer()` helper becomes:

```ts
const composer = (from?: Element | null) => {
  for (let el = from?.parentElement; el; el = el.parentElement) {
    const box = el.querySelector<HTMLElement>("[data-composer]");
    if (box) return box;
  }
  return document.querySelector<HTMLElement>('[data-composer][aria-label="Message"]');
};
```

Check that its callers only call `.focus()`. Search with `grep -n "composer(" clients/web/src/app/MessageList.tsx`.

In `skip-links.tsx` and `use-shortcuts.ts`, replace `'textarea[aria-label="Message"]'` with `'[data-composer][aria-label="Message"]'`, and `HTMLTextAreaElement` with `HTMLElement`.

Then run `grep -rn "textarea" clients/web/src --include=*.tsx --include=*.ts`, and confirm that no remaining hit refers to the composer.

- [ ] **Step 4: Update the e2e assertions**

In `clients/web/e2e/chat.spec.ts`, change every `toHaveValue(...)` on the Message box (lines ~227, 274, 278, 283; find them with `grep -n "toHaveValue" e2e/chat.spec.ts`) to `toHaveText(...)` with the same argument. Leave `toHaveValue` on other fields alone (emoji names, sound names, invite links).

- [ ] **Step 5: Typecheck, run the unit tests, and run e2e if possible**

Run: `pnpm exec tsc -p tsconfig.json && pnpm exec vitest run`
Expected: PASS.

E2E needs a running stack at `E2E_BASE_URL`. If none is available, say so in the report and do not claim it passed.

- [ ] **Step 6: Check in the browser (the controller does this if subagents cannot sign in)**

In the composer:
- typing `:smile:` turns it into 😄 at once;
- typing `:<custom>:` shows the image, and the caret stays after it;
- the emoji picker inserts at the caret;
- `@bo` + Enter completes the mention;
- Shift+Enter adds a line, and Shift+Enter at the end shows the empty line;
- pasting from a web page pastes plain text;
- a large paste becomes a snippet;
- Up on empty edits the last message;
- Escape clears a reply;
- the sent message renders exactly as typed.

- [ ] **Step 7: Stage**

```bash
git add clients/web/src/app/Composer.tsx clients/web/src/app/MessageList.tsx clients/web/src/components/skip-links.tsx clients/web/src/hooks/use-shortcuts.ts clients/web/e2e/chat.spec.ts
```

---

### Task 4: The edit box and the emoji fields use `RichInput`

**Files:**
- Modify: `clients/web/src/app/MessageList.tsx:818-830` (the edit `Textarea`)
- Modify: `clients/web/src/chat/EmojiInsertButton.tsx` (take a handle instead of a field id)
- Modify: `clients/web/src/app/ProfileStrip.tsx:100-104`
- Modify: `clients/web/src/app/settings/ProfileSettings.tsx:131-143`
- Modify: `clients/web/src/app/dialogs/ChannelSettingsDialog.tsx:93-97`
- Modify: `clients/web/src/app/dialogs/CreateChannelDialog.tsx:66-70`

**Interfaces:**
- Consumes: `RichInput` and `RichInputHandle`.
- Produces: `EmojiInsertButton({ field, value, onChange, label }: { field: React.RefObject<RichInputHandle>; value: string; onChange: (v: string) => void; label?: string })`.

- [ ] **Step 1: The message edit box**

Replace the edit `<Textarea …/>` with:

```tsx
            <RichInput value={draft} onChange={(v) => setDraft(v)} maxLength={4000} aria-label="Edit message" autoFocus
              className="min-h-16 rounded-md border bg-background px-3 py-2 text-title pointer-coarse:select-text focus-visible:ring-2 focus-visible:ring-ring"
              enterKeyHint={isTouchOnly() ? "enter" : undefined}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  stopEditing();
                } else if (enterAction({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing }, isTouchOnly()) === "send") {
                  e.preventDefault();
                  void save();
                }
              }} />
```

The old `onFocus` that put the caret at the end is covered by `autoFocus`. Remove the `Textarea` import if it is now unused.

- [ ] **Step 2: `EmojiInsertButton` takes a handle**

```tsx
import type { RefObject } from "react";
import { Smile } from "lucide-react";
import { RefButton } from "@/components/ref-button";
import { EmojiPicker, emojiText } from "./EmojiPicker";
import type { RichInputHandle } from "./RichInput";

/** An emoji button for a RichInput field: inserts the picked emoji at the caret (custom emoji as `:name:`). */
export function EmojiInsertButton({ field, value, onChange, label = "Emoji" }: {
  field: RefObject<RichInputHandle>;
  value: string;
  /** Gets the new text; it may trim it to a length limit. */
  onChange: (value: string) => void;
  label?: string;
}) {
  return (
    <EmojiPicker
      onPick={(v) => {
        const { start, end } = field.current?.selection() ?? { start: value.length, end: value.length };
        const piece = emojiText(v);
        onChange(value.slice(0, start) + piece + value.slice(end));
        requestAnimationFrame(() => field.current?.setSelection(start + piece.length));
      }}
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        field.current?.focus();
      }}
      trigger={
        <RefButton variant="ghost" size="icon" className="flex-none text-muted-foreground" aria-label={label} title="Emoji"><Smile /></RefButton>
      } />
  );
}
```

- [ ] **Step 3: Switch the four fields**

Each field gets a `const xRef = useRef<RichInputHandle>(null);` (import `useRef` and `RichInput` / `RichInputHandle`). Each `<Input …>` or `<Textarea …>` paired with an `EmojiInsertButton` becomes a `RichInput`, and the button gets `field={xRef}` instead of `fieldId`. Field by field:

**`ProfileStrip.tsx`, the Status field:**

```tsx
            <RichInput ref={statusRef} id={fieldId} aria-label="Status" placeholder="What are you up to?" value={status} autoFocus singleLine variant="input"
              onChange={(v) => setStatus(limit(v))} />
            <EmojiInsertButton field={statusRef} value={status} onChange={(v) => setStatus(limit(v))} />
```

**`ProfileSettings.tsx`, the Custom status field:**
- The label becomes `<FieldLabel id={`${customStatusId}-label`} htmlFor={customStatusId}>Custom status</FieldLabel>`.

```tsx
              <RichInput ref={customStatusRef} id={customStatusId} aria-labelledby={`${customStatusId}-label`} singleLine variant="input"
                placeholder="What are you up to?" value={customStatus} onChange={(v) => setCustomStatus(limit(v, 80))} />
              <EmojiInsertButton field={customStatusRef} label="Add emoji to custom status" value={customStatus} onChange={(v) => setCustomStatus(limit(v, 80))} />
```

**`ProfileSettings.tsx`, the About me field:**
- The label becomes `<FieldLabel id={`${aboutId}-label`} htmlFor={aboutId}>About me</FieldLabel>`.

```tsx
              <RichInput ref={aboutRef} id={aboutId} aria-labelledby={`${aboutId}-label`} aria-describedby={`${aboutId}-count`} variant="input"
                className="min-h-16 h-auto py-2" value={about} onChange={(v) => setAbout(limit(v, ABOUT_MAX))} />
              <EmojiInsertButton field={aboutRef} label="Add emoji to About me" value={about} onChange={(v) => setAbout(limit(v, ABOUT_MAX))} />
```

**`ChannelSettingsDialog.tsx` and `CreateChannelDialog.tsx`, the Name fields:**
- The label becomes `<FieldLabel id={`${nameId}-label`} htmlFor={nameId}>Name</FieldLabel>`.

```tsx
          <RichInput ref={nameRef} id={nameId} aria-labelledby={`${nameId}-label`} singleLine variant="input" maxLength={100}
            value={name} onChange={(v) => setName(Array.from(v).slice(0, 100).join(""))} /* CreateChannelDialog also: placeholder={PLACEHOLDERS[type]} autoFocus */ />
          <EmojiInsertButton field={nameRef} label="Insert emoji" value={name} onChange={(v) => setName(Array.from(v).slice(0, 100).join(""))} />
```

The old `<Input required>` blocked an empty name natively. Check each dialog's submit button and submit handler. If neither already refuses an empty `name.trim()`, add `disabled={!name.trim()}` to the submit button.

The e2e test fills "About me" with `getByLabel("About me").fill(...)`. With `aria-labelledby`, that still resolves, and Playwright's `fill` works on contenteditable.

- [ ] **Step 4: Typecheck and run the tests**

Run: `pnpm exec tsc -p tsconfig.json && pnpm exec vitest run && pnpm exec eslint src`
Expected: PASS, with no new lint errors.

- [ ] **Step 5: Stage**

```bash
git add clients/web/src/app/MessageList.tsx clients/web/src/chat/EmojiInsertButton.tsx clients/web/src/app/ProfileStrip.tsx clients/web/src/app/settings/ProfileSettings.tsx clients/web/src/app/dialogs/ChannelSettingsDialog.tsx clients/web/src/app/dialogs/CreateChannelDialog.tsx
```

---

## Final verification (after all tasks)

- `pnpm -r typecheck`, `pnpm --filter @datrope/web test` and `pnpm lint`
- `pnpm --filter @datrope/web e2e` against a running stack. If no stack is available, report "not run".
- The browser checklist in Task 3, Step 6, plus:
  - editing a message that contains a custom emoji shows the image, and saving keeps `:name:`;
  - the status and channel-name fields show emoji and submit on Enter;
  - the IME check: Windows Japanese IME or the Android keyboard, if available.

Report each result as it came out. Do not commit.
