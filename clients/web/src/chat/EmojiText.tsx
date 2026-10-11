import { Fragment } from "react";
import { useApp } from "@/session";
import { useEmojiData } from "./emoji-data";
import { sizedImage } from "@/lib/sized-image";

const SHORTCODE = /:[A-Za-z0-9_+-]{2,32}:/g;

/** Plain text with `:name:` shown as the server's custom emoji (or the Unicode emoji with that
 *  shortcode); for profile text such as a custom status or About me, which is not Markdown. */
export function EmojiText({ text }: { text: string }) {
  const emoji = useApp((s) => s.emoji);
  const shortcodes = useEmojiData()?.byShortcode;
  const byName = new Map(Object.values(emoji).map((e) => [e.name.toLowerCase(), e]));
  const out: (string | JSX.Element)[] = [];
  let last = 0;
  for (const m of text.matchAll(SHORTCODE)) {
    const name = m[0].slice(1, -1).toLowerCase();
    const custom = byName.get(name);
    const unicode = custom ? undefined : shortcodes?.get(name);
    if (!custom && !unicode) continue;
    out.push(text.slice(last, m.index));
    out.push(custom
      ? <img key={m.index} {...sizedImage(custom.url, 32)} alt={m[0]} title={m[0]} className="emoji" loading="lazy" draggable={false} />
      : unicode!);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out.map((x, i) => (typeof x === "string" ? <Fragment key={`t${i}`}>{x}</Fragment> : x))}</>;
}
