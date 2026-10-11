import { emojiList, type Emoji } from "@datrope/core";
import { memo, startTransition, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useEmojiData } from "./emoji-data";
import { sizedImage } from "@/lib/sized-image";

export type EmojiValue = { unicode: string } | { custom: Emoji };

/** The reaction string for a picked emoji: the Unicode emoji or `custom:<id>`. */
export const reactionKey = (v: EmojiValue) => ("unicode" in v ? v.unicode : `custom:${v.custom.id}`);
/** The composer text for a picked emoji: the Unicode emoji or `:name:`. */
export const emojiText = (v: EmojiValue) => ("unicode" in v ? v.unicode : `:${v.custom.name}:`);

// Emojibase groups (group 2, components, is not in the data).
const GROUPS: [number, string][] = [
  [0, "Smileys & emotion"], [1, "People & body"], [3, "Animals & nature"], [4, "Food & drink"],
  [5, "Travel & places"], [6, "Activities"], [7, "Objects"], [8, "Symbols"], [9, "Flags"],
];
const COLS = 8;

type Cell = { label: string; value: EmojiValue; show: ReactNode };
type Section = { id: string; name: string; icon: ReactNode; cells: Cell[] };

/** A popover emoji picker: search, the server's custom emoji, then the Unicode groups. */
export function EmojiPicker({ onPick, trigger, onOpenChange, onCloseAutoFocus }: {
  onPick: (value: EmojiValue) => void;
  /** The element that opens the picker; it must take a ref. */
  trigger: ReactNode;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (e: Event) => void;
}) {
  const [open, setOpen] = useState(false);
  const change = (o: boolean) => {
    setOpen(o);
    onOpenChange?.(o);
  };
  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      {/* Fade only: zooming a panel full of colour emoji makes opening feel heavy. */}
      <PopoverContent className="w-[352px] p-0 duration-100 [--tw-enter-scale:1]! [--tw-enter-translate-y:0]! [--tw-exit-scale:1]!" align="end" onCloseAutoFocus={onCloseAutoFocus} onContextMenu={(e) => e.stopPropagation()}>
        <PickerPanel onPick={(v) => {
          change(false);
          onPick(v);
        }} />
      </PopoverContent>
    </Popover>
  );
}

function PickerPanel({ onPick }: { onPick: (value: EmojiValue) => void }) {
  const custom = useApp(useShallow(emojiList));
  const data = useEmojiData();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query); // typing stays responsive while the grid filters
  // Draw the panel and search box first; fill the grid on the next frame.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    startTransition(() => setReady(true)); // after the first paint, without blocking input
  }, []);
  const [active, setActive] = useState(0);
  const grid = useRef<HTMLDivElement>(null);

  const sections = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const out: Section[] = [];
    const server = custom.filter((e) => e.name.toLowerCase().includes(q));
    if (server.length > 0) {
      out.push({
        id: "server", name: "Server", icon: <img {...sizedImage(server[0].url, 20)} alt="" className="size-5 object-contain" />,
        cells: server.map((e) => ({
          label: `:${e.name}:`, value: { custom: e },
          show: <img {...sizedImage(e.url, 28)} alt="" loading="lazy" className="size-7 object-contain" />,
        })),
      });
    }
    for (const [group, name] of GROUPS) {
      const all = data?.byGroup.get(group) ?? [];
      const list = q ? all.filter((e) => e.label.toLowerCase().includes(q) || e.shortcodes.some((s) => s.includes(q))) : all;
      if (list.length === 0) continue;
      out.push({
        id: `group-${group}`, name, icon: list[0].emoji,
        cells: list.map((e) => ({ label: e.label, value: { unicode: e.emoji }, show: e.emoji })),
      });
    }
    return out;
  }, [custom, data, deferredQuery]);

  // The list as fixed-height rows (section headers and rows of up to COLS cells), so only
  // the rows in view are rendered: the full Unicode set is ~1,900 buttons.
  const { cells, rows, items, offsets, total } = useMemo(() => {
    const cells: Cell[] = [];
    const rows: number[][] = []; // emoji rows as flat cell indices, for arrow-key moves
    const items: Item[] = [];
    const offsets: number[] = [];
    let y = 0;
    for (const s of sections) {
      items.push({ kind: "header", section: s });
      offsets.push(y);
      y += HEADER_H;
      for (let i = 0; i < s.cells.length; i += COLS) {
        const row = s.cells.slice(i, i + COLS);
        const first = cells.length;
        rows.push(row.map((_, j) => first + j));
        cells.push(...row);
        items.push({ kind: "row", cells: row, first });
        offsets.push(y);
        y += ROW_H;
      }
    }
    return { cells, rows, items, offsets, total: y };
  }, [sections]);
  const current = Math.min(active, Math.max(0, cells.length - 1));

  const [scrollTop, setScrollTop] = useState(0);
  const [pendingFocus, setPendingFocus] = useState<number | null>(null);
  const top = scrollTop - OVERSCAN;
  const bottom = scrollTop + VIEW_H + OVERSCAN;
  const firstVisible = Math.max(0, offsets.findIndex((o, k) => o + (items[k].kind === "header" ? HEADER_H : ROW_H) > top));
  let lastVisible = firstVisible;
  while (lastVisible < items.length - 1 && offsets[lastVisible + 1] < bottom) lastVisible++;

  // Scroll a cell's row into view, then focus the cell once that row is rendered.
  const focusCell = (i: number) => {
    setActive(i);
    const k = items.findIndex((it) => it.kind === "row" && i >= it.first && i < it.first + it.cells.length);
    const el = grid.current;
    if (el && k >= 0) {
      if (offsets[k] < el.scrollTop) el.scrollTop = offsets[k] - HEADER_H;
      else if (offsets[k] + ROW_H > el.scrollTop + VIEW_H) el.scrollTop = offsets[k] + ROW_H - VIEW_H;
      setScrollTop(el.scrollTop);
    }
    setPendingFocus(i);
  };
  useLayoutEffect(() => {
    if (pendingFocus === null) return;
    grid.current?.querySelector<HTMLButtonElement>(`[data-cell="${pendingFocus}"]`)?.focus();
    setPendingFocus(null);
  }, [pendingFocus, scrollTop]);

  const onGridKey = (e: KeyboardEvent) => {
    const r = rows.findIndex((row) => row.includes(current));
    if (r < 0) return;
    let next: number | undefined;
    if (e.key === "ArrowLeft") next = Math.max(0, current - 1);
    else if (e.key === "ArrowRight") next = Math.min(cells.length - 1, current + 1);
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const row = rows[r + (e.key === "ArrowUp" ? -1 : 1)];
      if (row) next = row[Math.min(rows[r].indexOf(current), row.length - 1)];
    }
    if (next === undefined) return;
    e.preventDefault();
    focusCell(next);
  };

  const jumpToSection = (id: string) => {
    const k = items.findIndex((it) => it.kind === "header" && it.section.id === id);
    if (k >= 0 && grid.current) {
      grid.current.scrollTop = offsets[k];
      setScrollTop(offsets[k]);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="border-b p-2">
        <Input value={query} placeholder="Search emoji" aria-label="Search emoji" autoFocus className="h-8"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            if (grid.current) grid.current.scrollTop = 0;
            setScrollTop(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && cells.length > 0) {
              e.preventDefault();
              focusCell(current);
            } else if (e.key === "Enter" && cells.length > 0) {
              e.preventDefault();
              onPick(cells[current].value);
            }
          }} />
        {sections.length > 1 && (
          <div className="mt-2 flex flex-wrap gap-0.5" role="group" aria-label="Emoji groups">
            {sections.map((s) => (
              <Button key={s.id} variant="ghost" size="icon-xs" className="size-7 text-base" aria-label={s.name} title={s.name}
                onClick={() => jumpToSection(s.id)}>
                {s.icon}
              </Button>
            ))}
          </div>
        )}
      </div>
      <div ref={grid} className="overflow-y-auto px-2" style={{ height: VIEW_H }} onKeyDown={onGridKey}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div className="relative" style={{ height: total }}>
          {ready && items.slice(firstVisible, lastVisible + 1).map((it, n) => {
            const k = firstVisible + n;
            return it.kind === "header" ? (
              <h3 key={`h-${it.section.id}`} className="absolute inset-x-0 flex items-end px-1 pb-1 text-xs font-semibold text-muted-foreground"
                style={{ top: offsets[k], height: HEADER_H }}>{it.section.name}</h3>
            ) : (
              <EmojiRow key={`r-${it.first}`} cells={it.cells} first={it.first} top={offsets[k]}
                active={current >= it.first && current < it.first + it.cells.length ? current : -1}
                onActive={setActive} onPick={onPick} />
            );
          })}
        </div>
        {!data && <p className="p-2 text-sm text-muted-foreground">Loading emoji…</p>}
        {data && sections.length === 0 && <p className="p-2 text-sm text-muted-foreground">No emoji found</p>}
      </div>
    </div>
  );
}

type Item = { kind: "header"; section: Section } | { kind: "row"; cells: Cell[]; first: number };

const HEADER_H = 28;
const ROW_H = 40;
const VIEW_H = 320;
const OVERSCAN = 80; // px rendered above and below the view

/** One row of up to COLS emoji. Memoized: an arrow key re-renders only the rows it leaves and enters. */
const EmojiRow = memo(function EmojiRow({ cells, first, top, active, onActive, onPick }: {
  cells: Cell[]; first: number; top: number; active: number;
  onActive: (i: number) => void; onPick: (value: EmojiValue) => void;
}) {
  return (
    <div className="absolute inset-x-0 grid grid-cols-8" style={{ top, height: ROW_H }}>
      {cells.map((cell, j) => {
        const i = first + j;
        return (
          <button key={i} type="button" data-cell={i} tabIndex={i === active || (active < 0 && i === 0 && first === 0) ? 0 : -1}
            aria-label={cell.label} title={cell.label}
            className="grid size-10 place-items-center rounded-md text-2xl leading-none outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onFocus={() => onActive(i)} onClick={() => onPick(cell.value)}>
            {cell.show}
          </button>
        );
      })}
    </div>
  );
});
