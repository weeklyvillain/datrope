import type { Attachment } from "@datrope/core";
import { client } from "@/session";

/** Sizes the server resizes images to with ?w= (variantBuckets in server/internal/files/variants.go). */
const BUCKETS = [32, 64, 128, 256, 512, 1024, 1600];

const bucket = (px: number) => BUCKETS.find((b) => b >= px) ?? BUCKETS[BUCKETS.length - 1];
const withWidth = (path: string, px: number) => `${path}${path.includes("?") ? "&" : "?"}w=${bucket(px)}`;

/** `src` and `srcSet` for a server image shown at most `cssPx` wide and tall: the server sends a
 *  copy that size, and twice that for HiDPI screens. Other URLs pass through unchanged. */
export function sizedImage(path: string, cssPx: number): { src: string; srcSet?: string } {
  if (!path.startsWith("/api/")) return { src: path };
  const one = client.url(withWidth(path, cssPx));
  const two = client.url(withWidth(path, cssPx * 2));
  return one === two ? { src: one } : { src: one, srcSet: `${one} 1x, ${two} 2x` };
}

/** sizedImage for an image attachment when the server makes resized copies (its thumbnail_url
 *  asks for a width); otherwise its stored thumbnail or the original. With `cover` the image fills a
 *  cssPx square (object-cover), so its shorter side must reach cssPx: the copies fit the longer one. */
export function attachmentImage(
  a: Pick<Attachment, "url" | "thumbnail_url" | "width" | "height">,
  cssPx: number,
  { cover = false }: { cover?: boolean } = {},
): { src: string; srcSet?: string } {
  if (a.thumbnail_url?.includes("?w=")) {
    const { width: w, height: h } = a;
    return sizedImage(a.url, cover && w && h ? (cssPx * Math.max(w, h)) / Math.min(w, h) : cssPx);
  }
  return { src: client.url(a.thumbnail_url || a.url) };
}