import type { Attachment } from "@datrope/core";

/** Whether to show an image in the message: its thumbnail, or the original only
 *  when it is small (or a modest GIF), so no viewer decodes a huge image. */
export function showable(a: Attachment): a is Attachment & { width: number; height: number } {
  if (!a.inline || !a.width || !a.height) return false;
  if (a.thumbnail_url) return true;
  if (a.width <= 400 && a.height <= 400) return true;
  return a.content_type === "image/gif" && a.width * a.height <= 4096 * 4096;
}

/** Fits an image into w x h without upscaling, keeping its shape. */
export function fitBox(w: number, h: number, maxW = 400, maxH = 300) {
  const scale = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Whether this browser can play the attachment in a message, and how. */
export function mediaKind(a: Attachment): "audio" | "video" | null {
  const kind = a.content_type.split("/")[0];
  if (kind !== "audio" && kind !== "video") return null;
  // Chromium reports no support for QuickTime but plays the usual H.264 .mov files.
  const type = a.content_type === "video/quicktime" ? "video/mp4" : a.content_type;
  return document.createElement(kind).canPlayType(type) ? kind : null;
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
