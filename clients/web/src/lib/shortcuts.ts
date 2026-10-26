export type ShortcutId = "channel-prev" | "channel-next" | "unread-prev" | "unread-next" | "search" | "mute" | "deafen" | "sheet";
// key is missing on the keydown Chrome sends when an autofill suggestion is picked.
export type KeyLike = { key?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean; code?: string };
type Group = "Navigation" | "Messages" | "Voice" | "Help";
type Target = { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown } | null;

/** Focus on things that use letters or arrows themselves: rows, sliders, tabs, options, menus and media players. */
const OWN_KEYS = "[data-message-row],[role=slider],[role=tab],[role=option],[role=listbox],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],video,audio";
type Def = { id: ShortcutId; keys: string[]; label: string; group: Group; alt?: boolean; mod?: boolean; shift?: boolean; key: string };

export const SHORTCUTS: Def[] = [
  { id: "channel-prev", keys: ["Alt", "↑"], label: "Previous channel", group: "Navigation", alt: true, key: "arrowup" },
  { id: "channel-next", keys: ["Alt", "↓"], label: "Next channel", group: "Navigation", alt: true, key: "arrowdown" },
  { id: "unread-prev", keys: ["Alt", "Shift", "↑"], label: "Previous unread channel", group: "Navigation", alt: true, shift: true, key: "arrowup" },
  { id: "unread-next", keys: ["Alt", "Shift", "↓"], label: "Next unread channel", group: "Navigation", alt: true, shift: true, key: "arrowdown" },
  { id: "search", keys: ["Ctrl", "F"], label: "Search", group: "Navigation", mod: true, key: "f" },
  { id: "mute", keys: ["Ctrl", "Shift", "M"], label: "Mute or unmute", group: "Voice", mod: true, shift: true, key: "m" },
  { id: "deafen", keys: ["Ctrl", "Shift", "D"], label: "Deafen or undeafen", group: "Voice", mod: true, shift: true, key: "d" },
  { id: "sheet", keys: ["Ctrl", "/"], label: "Keyboard shortcuts", group: "Help", mod: true, key: "/" },
];

/** Keys handled elsewhere, listed on the sheet only. */
export const OTHER_KEYS: { keys: string[]; label: string; group: Group }[] = [
  { keys: ["Ctrl", "K"], label: "Jump to or run a command", group: "Navigation" },
  { keys: ["↑"], label: "Edit your last message (empty message box)", group: "Messages" },
  { keys: ["Esc"], label: "Mark read and jump to newest", group: "Messages" },
  { keys: ["↑", "↓"], label: "Move between messages", group: "Messages" },
  { keys: ["R"], label: "Reply to the focused message", group: "Messages" },
  { keys: ["E"], label: "Edit the focused message", group: "Messages" },
  { keys: ["T"], label: "Open a thread on the focused message", group: "Messages" },
  { keys: ["P"], label: "Pin the focused message", group: "Messages" },
  { keys: ["+"], label: "React to the focused message", group: "Messages" },
  { keys: ["Enter"], label: "More actions for the focused message", group: "Messages" },
];

export function matchShortcut(e: KeyLike, mac: boolean): ShortcutId | null {
  if (e.isComposing || !e.key) return null;
  const mod = mac ? e.metaKey : e.ctrlKey;
  const otherMod = mac ? e.ctrlKey : e.metaKey;
  if (otherMod) return null;
  const key = e.key.toLowerCase();
  // "/" needs Shift on some layouts (Swedish: Shift+7), where it arrives as "/" or "?": ignore Shift for the sheet.
  if (mod && !e.altKey && (key === "/" || key === "?")) return "sheet";
  for (const s of SHORTCUTS) {
    if (!!s.alt === e.altKey && !!s.mod === mod && !!s.shift === e.shiftKey && s.key === key) return s.id;
  }
  return null;
}

export function isEditableTarget(t: Target): boolean {
  if (!t) return false;
  return !!t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName ?? "");
}

/** A printable key typed while nothing editable (and no message row, whose letters are actions) has focus: it should land in the message box. */
export function isTypeToFocus(e: KeyLike, target: Target): boolean {
  return (
    !e.isComposing && !e.ctrlKey && !e.metaKey && !e.altKey && e.key?.length === 1 && e.key !== " " &&
    !isEditableTarget(target) && !target?.closest?.(OWN_KEYS)
  );
}

export const isMac = () => typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

/** A key as shown on screen: Ctrl is the Command key on macOS. */
export const keyLabel = (k: string) => (k === "Ctrl" && isMac() ? "⌘" : k);

export const shortcutKeys = (id: ShortcutId) => SHORTCUTS.find((s) => s.id === id)?.keys ?? [];
