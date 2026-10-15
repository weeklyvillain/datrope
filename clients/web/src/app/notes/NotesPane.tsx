import type { NoteSummary } from "@datrope/core";
import { Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLayerNavigate } from "@/hooks/use-history-layer";
import { cn } from "@/lib/utils";
import { client, errorText } from "../../session";
import { createNoteSearch, type SearchState } from "./note-search";
import { displayTitle } from "./notes-model";
import { loadNotes, newNote, useNotes } from "./notes-store";

/** Search, the list of my notes and New note: the sidebar's Notes tab, and the phone's Notes screen. */
export function NotesPane({ activeId, className }: { activeId?: string; className?: string }) {
  const nav = useLayerNavigate();
  const summaries = useNotes((s) => s.summaries);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState<SearchState<NoteSummary>>({ found: null, error: "" });
  const [error, setError] = useState("");
  useEffect(() => {
    if (!summaries) loadNotes().catch((e: unknown) => setError(errorText(e)));
  }, [summaries]);
  // Searches the server (titles and full text); asked again when the list changes.
  const searcher = useMemo(() => createNoteSearch({ list: (query) => client.listNotes(query), delay: 250, onChange: setSearch }), []);
  useEffect(() => () => searcher.dispose(), [searcher]);
  useEffect(() => searcher.set(q), [searcher, q]);
  useEffect(() => searcher.refresh(), [searcher, summaries]);
  const create = () => {
    setError("");
    newNote().then((n) => nav(`/notes/${n.id}`, { state: { focusTitle: true } }), (e: unknown) => setError(errorText(e)));
  };
  const shown = search.found ?? summaries;
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="relative flex-none px-2 pt-2">
        <Search className="pointer-events-none absolute top-[calc(50%+0.25rem)] left-4 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input type="search" aria-label="Search notes" placeholder="Search notes" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
      </div>
      <nav aria-label="Notes" className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain p-2">
        {shown?.length === 0 && <p className="px-2 py-4 text-ui text-muted-foreground">{q.trim() ? "No notes match." : "No notes yet."}</p>}
        {shown?.map((n) => (
          <Link key={n.id} to={`/notes/${n.id}`} aria-current={n.id === activeId ? "page" : undefined}
            className={cn("block rounded-md px-2 py-1.5 text-foreground no-underline hover:bg-accent", n.id === activeId && "bg-accent")}>
            <span className="block truncate text-ui font-medium">{displayTitle(n.title)}</span>
            <span className="block truncate text-meta text-muted-foreground">{n.preview || "Empty note"}</span>
          </Link>
        ))}
      </nav>
      <div className="flex-none px-2 pb-2">
        {(error || search.error) && <p role="alert" className="pb-1 text-meta text-destructive">{error || search.error}</p>}
        <Button className="w-full" onClick={create}><Plus />New note</Button>
      </div>
    </div>
  );
}
