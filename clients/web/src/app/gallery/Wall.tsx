import type { ReactNode } from "react";
import type { GalleryItem } from "./items";
import { justify, ratio } from "./justify";

const GAP = 4; // px, set inline: Tailwind's gap-1 is 0.25rem = 3.75px with the app's 15px root, which would break the row math
const TARGET = 180;

/** Files in justified rows: each keeps its aspect ratio (files without one are square). */
export function Wall({ items, width, render }: {
  items: GalleryItem[]; width: number; render: (item: GalleryItem, size: { width: number; height: number }) => ReactNode;
}) {
  const rows = justify(items.map((it) => it.attachment), width, TARGET, GAP);
  return (
    <div className="grid" style={{ gap: GAP }}>
      {rows.map((r) => (
        <div key={items[r.start].attachment.id} className="flex" style={{ height: r.height, gap: GAP }}>
          {items.slice(r.start, r.end).map((it) => render(it, { width: ratio(it.attachment) * r.height, height: r.height }))}
        </div>
      ))}
    </div>
  );
}
