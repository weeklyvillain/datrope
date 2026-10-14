type Inline = "attach" | "code" | "emoji";
type MenuItem = "upload" | "code";

/** Which composer tools sit in the button row, and which hide in the attach menu (phones). */
export function composerTools(phone: boolean, canAttach: boolean): { inline: Inline[]; menu: MenuItem[] } {
  if (phone && canAttach) return { inline: ["attach", "emoji"], menu: ["upload", "code"] };
  return { inline: [...(canAttach && !phone ? (["attach"] as const) : []), "code", "emoji"], menu: [] };
}
