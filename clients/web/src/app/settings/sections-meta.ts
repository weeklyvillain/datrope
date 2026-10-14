import { Bell, Headphones, Link2, MonitorSmartphone, Palette, User, type LucideIcon } from "lucide-react";
import type { SettingsSection } from "./settings-store";

export type Group = "Account" | "App";
export const GROUPS: Group[] = ["Account", "App"];
export type SectionMeta = { id: SettingsSection; label: string; group: Group; icon: LucideIcon };

// Metadata only (no section bodies, which import the session): unit tests load this in node.
export const SECTION_META: SectionMeta[] = [
  { id: "profile", label: "My profile", group: "Account", icon: User },
  { id: "connections", label: "Connections", group: "Account", icon: Link2 },
  { id: "sessions", label: "Sessions", group: "Account", icon: MonitorSmartphone },
  { id: "notifications", label: "Notifications", group: "App", icon: Bell },
  { id: "voice", label: "Voice & audio", group: "App", icon: Headphones },
  { id: "appearance", label: "Appearance", group: "App", icon: Palette },
];

/** Guests have one session that ends with their access; there is nothing to manage. */
export function visibleSections<T extends SectionMeta>(me: { guest: boolean; admin: boolean }, all: T[] = SECTION_META as T[]): T[] {
  return me.guest ? all.filter((s) => s.id !== "sessions" && s.id !== "connections") : all;
}
