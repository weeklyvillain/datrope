/** Server colour presets (spec: custom colors §3). Each passes readableAccent unchanged. */
export const PALETTES = {
  emerald: { label: "Emerald", hex: "#2ecc71" },
  ocean: { label: "Ocean", hex: "#4aa3ff" },
  violet: { label: "Violet", hex: "#a78bfa" },
  amber: { label: "Amber", hex: "#f5a524" },
  rose: { label: "Rose", hex: "#fb7185" },
  mint: { label: "Mint", hex: "#2dd4bf" },
} as const;

export type Palette = keyof typeof PALETTES;

/** Role colours a role may have (server/internal/communities RoleColors). */
export const ROLE_COLORS = ["#e74c3c", "#f5a524", "#2ecc71", "#2dd4bf", "#4aa3ff", "#a78bfa", "#fb7185", "#969da2"] as const;
