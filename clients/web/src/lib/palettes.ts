/** Server palettes (spec: one-server design §2). The accent must keep #131313 text readable. */
export const PALETTES = {
  emerald: { label: "Emerald", accent: "#2ecc71" },
  ocean: { label: "Ocean", accent: "#4aa3ff" },
  violet: { label: "Violet", accent: "#a78bfa" },
  amber: { label: "Amber", accent: "#f5a524" },
  rose: { label: "Rose", accent: "#fb7185" },
  mint: { label: "Mint", accent: "#2dd4bf" },
} as const;

export type Palette = keyof typeof PALETTES;

/** Role colours a role may have (server/internal/communities RoleColors). */
export const ROLE_COLORS = ["#e74c3c", "#f5a524", "#2ecc71", "#2dd4bf", "#4aa3ff", "#a78bfa", "#fb7185", "#969da2"] as const;
