import { Children, isValidElement, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { VideoTile } from "../../voice/voice";
import { fitWidth } from "./fit";
import { InviteTile } from "./InviteTile";
import { Tile } from "./Tile";

/** One tile in the call: a person's camera or avatar, or a screen share. */
export interface Entry {
  userId: string;
  tile?: VideoTile;
}

export const entryKey = (e: Entry) => e.tile?.id ?? e.userId;

/** Every participant and screen share in a responsive grid, plus the invite tile in a small call. */
export function GridView({ entries, speaking, watching, chip, inviteTo, compact }: {
  entries: Entry[];
  speaking: string[];
  watching: string[];
  chip?: (e: Entry) => ReactNode;
  inviteTo?: string; // channel name; set when the invite tile may show
  compact?: boolean;
}) {
  const tiles = entries.map((e) => (
    <Tile key={entryKey(e)} userId={e.userId} tile={e.tile} size="grid" speaking={speaking.includes(e.userId)}
      watching={watching.includes(e.userId)} chip={chip?.(e)} />
  ));
  const invite = inviteTo !== undefined && <InviteTile channelName={inviteTo} />;
  if (compact) {
    return <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">{tiles}{invite}</div>;
  }
  return <FitGrid>{tiles}{invite}</FitGrid>;
}

/** Fills its parent: tiles grow and shrink so they all fit, centred. */
function FitGrid({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const items = Children.toArray(children); // drops the empty invite slot; keeps each tile's key
  const width = size.w ? fitWidth(items.length, size.w, size.h) : undefined;
  return (
    <div ref={ref} className="size-full overflow-y-auto">
      <div className="flex min-h-full flex-wrap content-center justify-center gap-3">
        {items.map((c) => <div key={isValidElement(c) ? c.key : undefined} className="shrink-0" style={{ width }}>{c}</div>)}
      </div>
    </div>
  );
}
