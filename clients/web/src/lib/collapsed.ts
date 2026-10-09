import { useState } from "react";

const KEY = "datrope.collapsedCategories";

// Used when localStorage is unavailable or holds something unreadable: collapsing then lasts for this session.
let memory = new Set<string>();

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return new Set();
    const ids: unknown = JSON.parse(raw);
    if (!Array.isArray(ids)) return memory;
    return new Set(ids.filter((x): x is string => typeof x === "string"));
  } catch {
    return memory;
  }
}

/** Whether a category is collapsed in the sidebar on this device. */
export function isCollapsed(id: string): boolean {
  return load().has(id);
}

export function setCollapsed(id: string, v: boolean) {
  const ids = load();
  if (v) ids.add(id);
  else ids.delete(id);
  memory = ids;
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    // Storage unavailable (private window): kept in memory only.
  }
}

/** A category's collapsed state, remembered per device. */
export function useCollapsed(id: string): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => isCollapsed(id));
  return [value, (v: boolean) => {
    setCollapsed(id, v);
    setValue(v);
  }];
}
