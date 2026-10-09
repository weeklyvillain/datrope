export const MAX_AVATAR_FILE = 2 * 1024 * 1024;
export const MAX_BANNER_FILE = 5 * 1024 * 1024;
export const AVATAR_SIZE = 256;

/** A crop: the frame others see inside a larger view (px), and the size of the uploaded image. */
export type CropSpec = { viewW: number; viewH: number; frameW: number; frameH: number; outW: number; outH: number };

export const AVATAR: CropSpec = { viewW: 220, viewH: 220, frameW: 180, frameH: 180, outW: AVATAR_SIZE, outH: AVATAR_SIZE };
export const BANNER: CropSpec = { viewW: 340, viewH: 140, frameW: 300, frameH: 100, outW: 960, outH: 320 };

export const CROP_VIEW = AVATAR.viewW; // the square crop area, in px
export const CROP_CIRCLE = AVATAR.frameW; // the circle others see

const TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function checkImageFile(f: { type: string; size: number }, max: number, label: string): string | null {
  if (!TYPES.includes(f.type)) return "Use a PNG, JPEG, WebP or GIF image";
  if (f.size > max) return `Larger than ${label}`;
  return null;
}

export const checkAvatarFile = (f: { type: string; size: number }) => checkImageFile(f, MAX_AVATAR_FILE, "2 MB");
export const checkBannerFile = (f: { type: string; size: number }) => checkImageFile(f, MAX_BANNER_FILE, "5 MB");

export type Crop = { zoom: number; x: number; y: number };

/** View px per source px: the image covers the frame at zoom 1. */
export const cropScale = (w: number, h: number, zoom: number, spec: CropSpec = AVATAR) =>
  Math.max(spec.frameW / w, spec.frameH / h) * zoom;

/** Keeps the zoom in 1–3 and the frame inside the image. */
export function clampCrop(w: number, h: number, c: Crop, spec: CropSpec = AVATAR): Crop {
  const zoom = Math.min(3, Math.max(1, c.zoom));
  const s = cropScale(w, h, zoom, spec);
  const mx = (w * s - spec.frameW) / 2;
  const my = (h * s - spec.frameH) / 2;
  const clamp = (v: number, m: number) => Math.min(m, Math.max(-m, v)) + 0; // + 0 turns -0 into 0 for toEqual
  return { zoom, x: clamp(c.x, mx), y: clamp(c.y, my) };
}

/** The part of the source image inside the frame. */
export function cropRect(w: number, h: number, c: Crop, spec: CropSpec = AVATAR): { sx: number; sy: number; sw: number; sh: number } {
  const { zoom, x, y } = clampCrop(w, h, c, spec);
  const s = cropScale(w, h, zoom, spec);
  const sw = spec.frameW / s;
  const sh = spec.frameH / s;
  const within = (v: number, max: number) => Math.min(max, Math.max(0, v)) + 0; // float error must not leave the image
  return { sx: within(w / 2 - x / s - sw / 2, w - sw), sy: within(h / 2 - y / s - sh / 2, h - sh), sw, sh };
}

/** Draws the crop at the spec's output size (a GIF's first frame) as WebP, or PNG (JPEG for banners) where WebP encoding is missing. */
export async function cropToBlob(img: HTMLImageElement, c: Crop, spec: CropSpec = AVATAR): Promise<Blob> {
  const { sx, sy, sw, sh } = cropRect(img.naturalWidth, img.naturalHeight, c, spec);
  const canvas = document.createElement("canvas");
  canvas.width = spec.outW;
  canvas.height = spec.outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot crop images.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, spec.outW, spec.outH);
  const webp = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", 0.9));
  if (webp && webp.type === "image/webp") return webp;
  // A 960 × 320 PNG photo can pass the server's 1 MB banner cap, so banners fall back to JPEG.
  const [type, quality] = spec === BANNER ? ["image/jpeg", 0.9] : ["image/png", undefined];
  const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, quality));
  if (!png) throw new Error("This browser cannot crop images.");
  return png;
}
