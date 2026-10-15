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
  let emptyAt = -1; // out.length right after an empty block line, which still separates from the next block
  const walk = (n: MiniNode, isRoot: boolean) => {
    const kids = n.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i]!;
      if (c.nodeType === 3) out += (c.data ?? "").replace(/\u00a0/g, " "); // browsers type NBSP for runs of spaces
      else if (c.nodeType !== 1) continue;
      else if (c.nodeName === "IMG") out += c.getAttribute?.("data-emoji") ?? "";
      else if (c.nodeName === "BR") {
        const filler = c.getAttribute?.("data-filler") != null;
        const trailing = isRoot && i === kids.length - 1;
        const blockFiller = kids.length === 1 && BLOCK.has(n.nodeName); // Chrome's empty line: the block start already broke the line
        if (!filler && !trailing && !blockFiller) out += "\n";
      } else {
        const block = BLOCK.has(c.nodeName);
        if (block && out && (!out.endsWith("\n") || out.length === emptyAt)) out += "\n";
        if (block && c.childNodes.length === 1 && c.childNodes[0]!.nodeName === "BR") emptyAt = out.length;
        walk(c, false);
      }
    }
  };
  walk(root, true);
  return out;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** How a length limit counts: UTF-16 units (a textarea's maxlength) or code points (an emoji is one). */
export type LengthUnit = "utf16" | "codepoint";
const measure = (s: string, unit: LengthUnit) => (unit === "codepoint" ? Array.from(s).length : s.length);

/** `value` with [start, end) replaced by `insert`, the insert cut so the result fits `max` (the text around it is
 *  never cut, and nothing is inserted when there is no room); the caret goes after the insert. */
export function spliceText(value: string, start: number, end: number, insert: string, max: number, unit: LengthUnit = "utf16"): { value: string; caret: number } {
  const room = Math.max(0, max - measure(value.slice(0, start), unit) - measure(value.slice(end), unit));
  let piece = unit === "codepoint" ? Array.from(insert).slice(0, room).join("") : insert.slice(0, room);
  if (piece.length < insert.length && isHigh(piece.charCodeAt(piece.length - 1))) piece = piece.slice(0, -1); // never leave half a surrogate pair
  return { value: value.slice(0, start) + piece + value.slice(end), caret: start + piece.length };
}

/** An edit from `prev` to `next` (caret `caret`), kept within `max` the way a textarea's maxlength keeps it: an edit
 *  that would grow the text past the limit has its inserted part cut (to nothing for a single keystroke), and the
 *  rest of the text stays. Edits that fit, or that shorten the text, pass through. */
export function limitEdit(prev: string, next: string, caret: number, max: number, unit: LengthUnit = "utf16"): { value: string; caret: number } {
  if (measure(next, unit) <= max || next.length <= prev.length) return { value: next, caret };
  // A plain insert just before the caret (typing, IME, autocorrect): anchor on it, so repeated letters around the
  // caret don't move the cut. Anything else: the common prefix and suffix.
  const at = caret - (next.length - prev.length);
  const inserted = at >= 0 && next.startsWith(prev.slice(0, at)) && next.slice(caret) === prev.slice(at);
  let p = 0;
  if (inserted) p = at;
  else while (p < prev.length && prev[p] === next[p]) p++;
  if (p > 0 && isHigh(prev.charCodeAt(p - 1))) p--;
  let s = 0;
  if (inserted) s = prev.length - p;
  else while (s < prev.length - p && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
  if (s > 0 && isLow(prev.charCodeAt(prev.length - s))) s--;
  return spliceText(prev, p, prev.length - s, next.slice(p, next.length - s), max, unit);
}
