import { Search, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { closePanel, openPanel, panelStore, setSearchQuery, usePanel } from "../side-panel/panel";
import { clearSearchResults } from "./results";

/** The operator hints shown while the box is focused and empty (Search.html 3b). */
const HINTS: { insert: string; ops: string[]; text: string }[] = [
  { insert: "from:", ops: ["from:"], text: "a person" },
  { insert: "in:#", ops: ["in:"], text: "a channel or DM" },
  { insert: "has:", ops: ["has:"], text: "link or file" },
  { insert: "before:", ops: ["before:", "after:"], text: "a date, like 2026-05-01" },
];

/** The header search box. Enter opens the results in the side panel, which follows the query. */
export function SearchBox() {
  const query = usePanel((s) => s.query);
  const [focused, setFocused] = useState(false);
  const mobile = useIsMobile();
  const [expanded, setExpanded] = useState(false); // phones: an icon until tapped, then the box spans the top bar
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const insert = (op: string) => {
    const q = query.trim();
    setSearchQuery(q ? `${q} ${op}` : op);
    box.current?.querySelector("input")?.focus();
  };
  const clear = () => {
    setSearchQuery("");
    clearSearchResults();
    if (panelStore.getState().panel?.kind === "search") closePanel();
  };

  if (mobile && !expanded && !query) {
    return (
      <Button variant="ghost" size="icon-sm" aria-label="Search" className="text-muted-foreground" onClick={() => setExpanded(true)}>
        <Search />
      </Button>
    );
  }
  return (
    <Popover open={focused && !query}>
      <PopoverAnchor asChild>
        <div ref={box} className={cn("relative w-[260px] flex-none max-[760px]:w-40",
          mobile && "absolute inset-x-2 top-1/2 z-10 w-auto -translate-y-1/2 bg-topbar max-[760px]:w-auto")}>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input aria-label="Search" placeholder="Search" className="h-8 pr-8 pl-8" value={query}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoFocus={mobile}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              if (!query) setExpanded(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (query.trim()) openPanel({ kind: "search" });
              } else if (e.key === "Escape") {
                e.currentTarget.blur();
              }
            }} />
          {query && (
            <Button variant="ghost" size="icon-sm" aria-label="Clear search"
              className="absolute top-1/2 right-0.5 size-7 -translate-y-1/2 text-muted-foreground" onClick={clear}>
              <X />
            </Button>
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" className="w-[300px] px-0 py-2.5" onOpenAutoFocus={(e) => e.preventDefault()}>
        <p id={titleId} className="mx-3.5 mt-1 mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Search options</p>
        <div role="listbox" aria-labelledby={titleId}>
          {HINTS.map((h) => (
            <div key={h.insert} role="option" aria-selected={false} className="cursor-pointer px-3.5 py-1.5 text-sm hover:bg-accent"
              onMouseDown={(e) => {
                e.preventDefault(); // keep focus in the box
                insert(h.insert);
              }}>
              {h.ops.map((op, i) => (
                <span key={op}>{i > 0 && " / "}<code className="font-mono text-primary">{op}</code></span>
              ))}{" "}
              <span className="text-muted-foreground">{h.text}</span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
