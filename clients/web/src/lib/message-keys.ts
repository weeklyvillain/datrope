export type MessageKey = "prev" | "next" | "first" | "last" | "menu" | "reply" | "edit" | "thread" | "pin" | "react" | "delete" | "composer";

const KEYS: Record<string, MessageKey> = {
  ArrowUp: "prev", ArrowDown: "next", Home: "first", End: "last", Enter: "menu",
  r: "reply", e: "edit", t: "thread", p: "pin", "+": "react", Delete: "delete", Escape: "composer",
};

/** What a key does on a message row. `onRow`: the row itself has focus, not a link, button or field inside it. */
export function messageKeyAction(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing?: boolean }, onRow: boolean): MessageKey | null {
  if (!onRow || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return null;
  return KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key] ?? null;
}
