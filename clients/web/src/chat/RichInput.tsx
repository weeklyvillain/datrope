import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import { useApp } from "@/session";
import { sizedImage } from "@/lib/sized-image";
import { cn } from "@/lib/utils";
import { useEmojiData } from "./emoji-data";
import { convertShortcodeAt, limitEdit, segments, serialize, spliceText, type LengthUnit } from "./rich-text";

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
  lengthUnit?: LengthUnit; // how maxLength counts: UTF-16 units like a textarea (default), or code points
  singleLine?: boolean; // Enter does nothing (the caller may submit); newlines are stripped
  autoFocus?: boolean; // focuses with the caret at the end
  variant?: "bare" | "input"; // "input" looks like components/ui/input.tsx
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "onChange" | "onSelect" | "onPaste" | "onKeyDown" | "contentEditable" | "children">;

/** Same look as components/ui/input.tsx, for single-line fields. Copy the class list from there when it changes. */
const INPUT_LOOK =
  "h-9 pointer-coarse:min-h-[44px] w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-title shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring";

/** The string offset of a DOM point inside `root`: the serialized length of everything before it. */
function offsetAt(root: HTMLElement, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(node, offset);
  const box = document.createElement("div");
  box.append(r.cloneContents());
  return serialize(box).length;
}

/** The DOM point for string offset `want`: in a text node, or between root children around atoms. */
function pointAt(root: HTMLElement, want: number): [Node, number] {
  let acc = 0;
  const kids = Array.from(root.childNodes);
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i]!;
    if (c.nodeType === Node.TEXT_NODE) {
      const len = (c as Text).data.length;
      if (want <= acc + len) return [c, Math.max(0, want - acc)];
      acc += len;
    } else {
      if (want <= acc) return [root, i]; // before an atom (or our filler <br>)
      acc = offsetAt(root, root, i + 1); // an atom or a browser-made element, measured as selection() measures it
    }
  }
  const last = kids[kids.length - 1] as HTMLElement | undefined;
  return [root, last?.dataset?.filler !== undefined ? kids.length - 1 : kids.length];
}

const clampSel = (s: { start: number; end: number }, len: number) => ({ start: Math.min(s.start, len), end: Math.min(s.end, len) });

export const RichInput = forwardRef<RichInputHandle, RichInputProps>(function RichInput(
  { value, onChange, onSelect, onPaste, onKeyDown, placeholder, maxLength = Infinity, lengthUnit = "utf16", singleLine = false, autoFocus, variant = "bare", className, ...rest },
  ref,
) {
  const root = useRef<HTMLDivElement>(null);
  const pending = useRef<number | null>(null); // caret to restore after the next render
  const composing = useRef(false);
  const preCompose = useRef(""); // the value when the composition started: the base its length limit is checked against
  const reported = useRef<string | null>(null); // the last value onChange got while composing
  const aborting = useRef(false); // ending a composition ourselves: the events the browser fires for it are ignored
  const pointerFocus = useRef(false); // the next focus comes from a click or tap, which places the caret itself
  const valueRef = useRef(value); // the latest value, so selection() and the handle stay stable across keystrokes
  // The last selection inside the box, kept like a textarea keeps it while focus is elsewhere (an emoji picker's search).
  const lastSel = useRef<{ start: number; end: number } | null>(null);
  const emoji = useApp((s) => s.emoji);
  const data = useEmojiData();
  const custom = useMemo(() => new Map(Object.values(emoji).map((e) => [e.name.toLowerCase(), sizedImage(e.url, 22)])), [emoji]);

  useLayoutEffect(() => {
    valueRef.current = value;
  }, [value]);

  const selection = useCallback((): { start: number; end: number } => {
    const el = root.current;
    const sel = typeof window === "undefined" ? null : window.getSelection();
    const len = valueRef.current.length;
    if (!el || !sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return lastSel.current ? clampSel(lastSel.current, len) : { start: len, end: len };
    const r = sel.getRangeAt(0);
    const a = offsetAt(el, r.startContainer, r.startOffset);
    const b = offsetAt(el, r.endContainer, r.endOffset);
    return { start: Math.min(a, b), end: Math.max(a, b) };
  }, []);

  const setSelection = useCallback((start: number, end = start) => {
    const el = root.current;
    if (!el) return;
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(...pointAt(el, start));
    r.setEnd(...pointAt(el, end));
    // Set first: adding the range can focus the box, and onFocus restores lastSel.
    lastSel.current = clampSel({ start, end }, valueRef.current.length);
    sel?.removeAllRanges();
    sel?.addRange(r);
  }, []);

  // `el` is a getter so the handle never holds a stale node.
  useImperativeHandle(ref, () => ({
    get el() {
      return root.current;
    },
    focus: () => root.current?.focus(), // onFocus puts the caret back
    selection,
    setSelection,
  }), [selection, setSelection]);

  /** Whether the DOM already shows `v`: the same string, one <img> per custom-emoji atom, and nothing but text, atoms
   *  and our filler <br> at the top level (a browser's <b>, <div> or pasted <img> gets cleaned up). */
  const inSync = useCallback((el: HTMLElement, v: string) => {
    const atoms = segments(v, (n) => custom.has(n)).filter((s) => s.kind === "emoji").length;
    const ours = (n: ChildNode) =>
      n.nodeType === Node.TEXT_NODE ||
      (n instanceof HTMLElement && ((n.nodeName === "IMG" && n.hasAttribute("data-emoji")) || (n.nodeName === "BR" && n.hasAttribute("data-filler"))));
    return serialize(el) === v && el.querySelectorAll("img[data-emoji]").length === atoms && Array.from(el.childNodes).every(ours);
  }, [custom]);

  /** Rebuilds the DOM from `v` (text nodes and emoji atoms) and, when focused, puts the caret at `caret`. */
  const project = useCallback((v: string, caret: number | null) => {
    const el = root.current;
    if (!el) return;
    const segs = segments(v, (n) => custom.has(n));
    el.replaceChildren(...segs.map((s) => {
      if (s.kind === "text") return document.createTextNode(s.text);
      const img = document.createElement("img");
      const src = custom.get(s.code.slice(1, -1).toLowerCase())!;
      img.src = src.src;
      if (src.srcSet) img.srcset = src.srcSet;
      img.alt = s.code;
      img.className = "emoji"; // sized by img.emoji in styles.css
      img.draggable = false;
      img.contentEditable = "false";
      img.setAttribute("data-emoji", s.code);
      return img;
    }));
    if (v.endsWith("\n")) {
      const br = document.createElement("br");
      br.setAttribute("data-filler", "");
      el.append(br);
    }
    if (caret !== null && document.activeElement === el) setSelection(Math.min(caret, v.length));
  }, [custom, setSelection]);

  // Project the string into the DOM when the DOM does not already say the same thing (an outside change, or a
  // :code: that just became an atom). During IME composition only an outside change (an autocomplete pick) does,
  // after ending the composition: the keyboard would otherwise keep composing over the old text.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    if (composing.current) {
      if (value === reported.current) return;
      composing.current = false;
      el.removeAttribute("data-composing");
      if (document.activeElement === el) {
        aborting.current = true;
        try {
          el.blur();
          el.focus();
        } finally {
          aborting.current = false;
        }
      }
    }
    const want = pending.current;
    pending.current = null;
    if (inSync(el, value)) {
      // Only move the caret when it is not already there: resetting the selection on every keystroke would
      // restart a mobile keyboard's word composition.
      if (want !== null && document.activeElement === el) {
        const cur = selection();
        if (cur.start !== want || cur.end !== want) setSelection(want);
      }
      return;
    }
    // Replaced from outside while focus is elsewhere: the next focus puts the caret at the end, like a textarea.
    if (want === null && document.activeElement !== el) lastSel.current = { start: value.length, end: value.length };
    project(value, want ?? (document.activeElement === el ? selection().start : null));
  }, [value, inSync, project, selection, setSelection]);

  useEffect(() => {
    if (!autoFocus) return;
    root.current?.focus();
    setSelection(value.length);
    // Only on mount, like the textarea's autoFocus plus the old onFocus "caret to end".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Applies a new string and caret, with the length limit (checked against `base`, the value the edit started from),
   *  the single-line rule and :shortcode: conversion. */
  const commit = (next: string, caret: number, base = valueRef.current) => {
    const flat = singleLine ? next.replace(/\n/g, " ") : next;
    const l = limitEdit(base, flat, caret, maxLength, lengthUnit); // a keystroke past the limit comes back as `base`
    const c = convertShortcodeAt(l.value, Math.min(l.caret, l.value.length), data?.byShortcode ?? null);
    pending.current = c.value === valueRef.current ? null : c.caret; // no render follows an unchanged value
    lastSel.current = { start: c.caret, end: c.caret };
    onChange(c.value, c.caret);
    // When the parent keeps its old value (it clamps the text itself, or the edit was undone above) it does not
    // re-render, so the layout effect never sees what the browser typed: undo it here. onChange queued React's
    // flush microtask before this one, so valueRef is the new value after a render and the old one after a bail-out.
    queueMicrotask(() => {
      const el = root.current;
      if (!el || composing.current || inSync(el, valueRef.current)) return;
      pending.current = null;
      project(valueRef.current, lastSel.current?.start ?? null);
    });
  };

  const insertText = (text: string) => {
    const { start, end } = selection();
    const s = spliceText(value, start, end, text, maxLength, lengthUnit);
    commit(s.value, s.caret);
  };

  // Structural edits the browser would do its own way (new <div>s, bold, drops) go through the string instead.
  // The listener is added once and calls the latest handler through a ref (updated at commit, before the
  // browser can fire another event), so no beforeinput lands between a removal and a re-add or sees a stale value.
  const beforeInput = useRef<(e: InputEvent) => void>(() => {});
  useLayoutEffect(() => {
    beforeInput.current = (e) => {
      if (e.isComposing || composing.current) return;
      if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") {
        e.preventDefault();
        if (!singleLine) insertText("\n");
      } else if (e.inputType.startsWith("format") || e.inputType === "insertFromDrop" || e.inputType === "insertFromPaste") {
        e.preventDefault(); // paste is handled in onPaste; drops of files go to the form
      }
    };
  });
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const before = (e: InputEvent) => beforeInput.current(e);
    el.addEventListener("beforeinput", before);
    return () => el.removeEventListener("beforeinput", before);
  }, []);

  // Caret moves (clicks, arrow keys): remembered for selection() and reported for autocomplete.
  useEffect(() => {
    const on = () => {
      if (document.activeElement !== root.current) return;
      const s = selection();
      lastSel.current = s;
      onSelect?.(s.start);
    };
    document.addEventListener("selectionchange", on);
    return () => document.removeEventListener("selectionchange", on);
  }, [onSelect, selection]);

  const empty = value === "";
  return (
    <div
      role="textbox"
      spellCheck
      tabIndex={0}
      aria-multiline={!singleLine}
      {...rest}
      ref={root}
      contentEditable="true"
      suppressContentEditableWarning
      aria-placeholder={empty ? placeholder : undefined}
      data-placeholder={placeholder}
      data-empty={empty || undefined}
      // whitespace-pre (not nowrap) in single-line mode: collapsing whitespace makes the browser type NBSPs.
      className={cn("rich-input whitespace-pre-wrap break-words outline-none", singleLine && "overflow-hidden whitespace-pre", variant === "input" && INPUT_LOOK, className)}
      onInput={() => {
        if (aborting.current || !root.current) return;
        if (composing.current) {
          // Report the raw text, so autocomplete, the Send button and typing follow a keyboard that composes whole
          // words. The limit, :shortcode: conversion and projection wait for compositionend.
          const v = serialize(root.current);
          reported.current = v;
          onChange(v, selection().start);
          return;
        }
        commit(serialize(root.current), selection().start);
      }}
      onCompositionStart={(e) => {
        composing.current = true;
        preCompose.current = valueRef.current;
        reported.current = valueRef.current;
        // `value` is still "" until compositionend, so this hides the placeholder over the composing text.
        e.currentTarget.setAttribute("data-composing", "");
      }}
      onCompositionEnd={(e) => {
        if (aborting.current || !composing.current) return; // a composition we ended ourselves
        composing.current = false;
        e.currentTarget.removeAttribute("data-composing");
        if (root.current) commit(serialize(root.current), selection().start, preCompose.current);
      }}
      onPointerDown={() => {
        if (document.activeElement !== root.current) pointerFocus.current = true;
      }}
      // A touch that became a scroll never focuses (and a tap focuses only after pointerup, so that can't clear it).
      onPointerCancel={() => { pointerFocus.current = false; }}
      onFocus={(e) => {
        const byPointer = pointerFocus.current;
        pointerFocus.current = false;
        if (byPointer || aborting.current || e.target !== e.currentTarget) return;
        // Chromium puts the caret at the start on a programmatic or Tab focus: go back to where it was, or to the end.
        const len = valueRef.current.length;
        const s = lastSel.current ? clampSel(lastSel.current, len) : { start: len, end: len };
        setSelection(s.start, s.end);
      }}
      onPaste={(e) => {
        const sel = selection();
        onPaste?.(e, sel);
        if (e.isDefaultPrevented()) return;
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain");
        if (!text) return; // an image-only paste the caller did not take: inserting "" would delete the selection
        insertText(text.replace(/\r\n?/g, "\n"));
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length > 0) return; // the form takes files
        e.preventDefault();
        insertText(e.dataTransfer.getData("text/plain"));
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        // Enter that confirms an IME candidate is not a submit (Safari sends it after compositionend, as keyCode 229).
        if (!e.isDefaultPrevented() && singleLine && e.key === "Enter" && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
          e.preventDefault();
          // Like Enter in an <input>: submit through the form's submit button, and not at all while it is disabled.
          const form = e.currentTarget.closest("form");
          const btn = Array.from(form?.elements ?? []).find((b): b is HTMLButtonElement => b instanceof HTMLButtonElement && b.type === "submit");
          if (form && !btn?.disabled) form.requestSubmit(btn);
        }
      }}
    />
  );
});
