export const MAX_AVATAR_FILE = 2 * 1024 * 1024;
export const AVATAR_SIZE = 256;
export const CROP_VIEW = 220; // the square crop area, in px
export const CROP_CIRCLE = 180; // the circle others see

const TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export function checkAvatarFile(f: { type: string; size: number }): string | null {
  if (!TYPES.includes(f.type)) return "Use a PNG, JPEG, WebP or GIF image";
  if (f.size > MAX_AVATAR_FILE) return "Larger than 2 MB";
  return null;
}

export type Crop = { zoom: number; x: number; y: number };

const scaleFor = (w: number, h: number, zoom: number) => (CROP_CIRCLE / Math.min(w, h)) * zoom;

/** Keeps the zoom in 1–3 and the circle inside the image. */
export function clampCrop(w: number, h: number, c: Crop): Crop {
  const zoom = Math.min(3, Math.max(1, c.zoom));
  const s = scaleFor(w, h, zoom);
  const mx = (w * s - CROP_CIRCLE) / 2;
  const my = (h * s - CROP_CIRCLE) / 2;
  const clamp = (v: number, m: number) => Math.min(m, Math.max(-m, v)) + 0; // + 0 turns -0 into 0 for toEqual
  return { zoom, x: clamp(c.x, mx), y: clamp(c.y, my) };
}

/** The square of the source image inside the circle. */
export function cropRect(w: number, h: number, c: Crop): { sx: number; sy: number; size: number } {
  const { zoom, x, y } = clampCrop(w, h, c);
  const s = scaleFor(w, h, zoom);
  const size = CROP_CIRCLE / s;
  return { sx: w / 2 - x / s - size / 2 + 0, sy: h / 2 - y / s - size / 2 + 0, size };
}

/** Draws the crop at 256 × 256 (a GIF's first frame) as WebP, or PNG where WebP encoding is missing. */
export async function cropToBlob(img: HTMLImageElement, c: Crop): Promise<Blob> {
  const { sx, sy, size } = cropRect(img.naturalWidth, img.naturalHeight, c);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot crop images.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, size, size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  const webp = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", 0.9));
  if (webp && webp.type === "image/webp") return webp;
  const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!png) throw new Error("This browser cannot crop images.");
  return png;
}
