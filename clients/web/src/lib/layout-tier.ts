/** Desktop layout tiers (see the desktop UX spec, 1.1). "phone" is the mobile shell below 768 px. */
export type LayoutTier = "phone" | "narrow" | "medium" | "wide";

export const TIER_QUERIES = { phone: "(max-width: 767px)", medium: "(min-width: 1024px)", wide: "(min-width: 1280px)" };

export function tierFor(width: number): LayoutTier {
  if (width < 768) return "phone";
  if (width < 1024) return "narrow";
  if (width < 1280) return "medium";
  return "wide";
}
