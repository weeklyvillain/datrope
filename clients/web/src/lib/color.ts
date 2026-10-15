/** Colour maths for server accents and one-colour themes (spec: custom colors). Hex is "#rrggbb", lowercase. */

export type Oklch = { l: number; c: number; h: number };
export type Hsv = { h: number; s: number; v: number };

const HEX = /^#[0-9a-f]{6}$/;
export const isHex = (s: string) => HEX.test(s);

/** "#A1B2C3", "a1b2c3" → "#a1b2c3"; anything else → undefined. */
export function normalizeHex(s: string): string | undefined {
  const t = s.trim().toLowerCase();
  const hex = t.startsWith("#") ? t : `#${t}`;
  return isHex(hex) ? hex : undefined;
}

const DARK = "#131313";
const WHITE = "#ffffff";
/** The default theme's background, sidebar and card: what a server accent must read against. */
export const DEFAULT_SURFACES = [DARK, "#0d0d0d", "#1c1c1c"];

type Rgb = [number, number, number];
const toRgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
const toHex = (rgb: Rgb) =>
  "#" + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const gam = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055);

export function toOklch(hex: string): Oklch {
  const [r, g, b] = toRgb(hex).map(lin) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  return { l: L, c, h: c < 1e-4 ? 0 : (Math.atan2(B, A) * 180) / Math.PI + (B < 0 ? 360 : 0) };
}

function linearRgb({ l, c, h }: Oklch): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -1e-6 && v <= 1 + 1e-6);

/** OKLCH → hex. Out-of-gamut colours lose chroma (same lightness and hue) until they fit sRGB. */
export function fromOklch(o: Oklch): string {
  const l = Math.min(1, Math.max(0, o.l));
  let rgb = linearRgb({ ...o, l });
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = o.c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(linearRgb({ l, c: mid, h: o.h }))) lo = mid;
      else hi = mid;
    }
    rgb = linearRgb({ l, c: lo, h: o.h });
  }
  return toHex(rgb.map(gam) as Rgb);
}

export function toHsv(hex: string): Hsv {
  const [r, g, b] = toRgb(hex);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

export function fromHsv({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return toHex([f(5), f(3), f(1)]);
}

const luminance = (hex: string) => {
  const [r, g, b] = toRgb(hex).map(lin) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG 2 contrast ratio, 1–21. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** The colour, lightened (hue and chroma kept) just enough to reach `ratio` against every colour in `against`. */
export function fitLightness(hex: string, against: string[], ratio: number): string {
  const passes = (h: string) => against.every((a) => contrast(h, a) >= ratio);
  if (passes(hex)) return hex;
  const o = toOklch(hex);
  let lo = o.l;
  let hi = 1;
  let best = fromOklch({ ...o, l: 1 });
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const h = fromOklch({ ...o, l: mid });
    if (passes(h)) {
      hi = mid;
      best = h;
    } else lo = mid;
  }
  return best;
}

/** Readable text on a filled colour: whichever of near-black and white contrasts more. */
export const labelOn = (hex: string) => (contrast(hex, DARK) >= contrast(hex, WHITE) ? DARK : WHITE);

/**
 * An accent that reads on `surfaces` (default 4.5:1, as links and text-primary are text; 3:1 for dots and badges)
 * and carries a label (≥ 4.5:1). Passing colours come back unchanged.
 */
export function readableAccent(hex: string, surfaces: string[] = DEFAULT_SURFACES, ratio = 4.5) {
  let primary = fitLightness(hex, surfaces, ratio);
  if (contrast(primary, labelOn(primary)) < 4.5) primary = fitLightness(primary, [DARK], 4.5);
  return { primary, primaryForeground: labelOn(primary) };
}

/** The surfaces text must read on. */
export const SURFACE_TOKENS = ["--sidebar", "--background", "--card", "--muted", "--secondary"] as const;

/** Every colour token from one seed: surfaces tinted with its hue, text and signals fitted to AA, the accent only if `ownAccent`. */
export function deriveTheme(seed: string, { ownAccent }: { ownAccent: boolean }): Record<string, string> {
  const { c, h } = toOklch(seed);
  const tint = Math.min(c, 0.05);
  const surface = (l: number) => fromOklch({ l, c: tint, h });
  const sidebar = surface(0.16);
  const background = surface(0.195);
  const card = surface(0.235);
  const muted = surface(0.29);
  const secondary = surface(0.37);
  const surfaces = [sidebar, background, card, muted, secondary];
  const text = (l: number, ratio: number) => fitLightness(fromOklch({ l, c: Math.min(tint, 0.02), h }), surfaces, ratio);
  const foreground = text(0.86, 7);
  const signal = (l: number, chroma: number, hue: number) => readableAccent(fromOklch({ l, c: chroma, h: hue }), [sidebar, card], 3);
  // Red is also error text, so it reads on every surface; online and idle are dots.
  const red = readableAccent(fromOklch({ l: 0.64, c: 0.19, h: 27 }), surfaces);
  const vars: Record<string, string> = {
    "--background": background,
    "--foreground": foreground,
    "--card": card,
    "--card-foreground": foreground,
    "--popover": card,
    "--popover-foreground": foreground,
    "--secondary": secondary,
    "--secondary-foreground": foreground,
    "--muted": muted,
    "--muted-foreground": text(0.7, 4.5),
    "--accent": muted,
    "--accent-foreground": foreground,
    "--border": secondary,
    "--input": fitLightness(surface(0.45), [background, card], 3),
    "--sidebar": sidebar,
    "--sidebar-foreground": foreground,
    "--topbar": card,
    "--topbar-foreground": foreground,
    "--destructive": red.primary,
    "--destructive-foreground": red.primaryForeground,
    "--mention": red.primary,
    "--mention-foreground": red.primaryForeground,
    "--online": signal(0.72, 0.17, 150).primary,
    "--idle": signal(0.72, 0.15, 80).primary,
  };
  if (ownAccent) {
    const { primary, primaryForeground } = readableAccent(seed, [background, sidebar, card]);
    Object.assign(vars, { "--primary": primary, "--primary-foreground": primaryForeground, "--ring": primary });
  }
  return vars;
}
