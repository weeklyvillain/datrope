export type Piece = { text: string; mark: boolean };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Splits text into pieces, marking whole-word, case-insensitive matches of terms
 *  (as the server's 'simple' full-text search matches them). */
export function splitHighlights(text: string, terms: string[]): Piece[] {
  const words = terms.filter((t) => /[\p{L}\p{N}]/u.test(t)).sort((a, b) => b.length - a.length).map(escape);
  if (words.length === 0 || !text) return [{ text, mark: false }];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join("|")})(?![\\p{L}\\p{N}])`, "giu");
  const out: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index), mark: false });
    out.push({ text: m[0], mark: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), mark: false });
  return out.length > 0 ? out : [{ text, mark: false }];
}
