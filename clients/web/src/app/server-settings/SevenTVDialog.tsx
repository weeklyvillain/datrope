import type { SevenTVEmote } from "@datrope/core";
import { Check } from "@/components/icons";
import { useEffect, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSubmit } from "@/hooks/use-submit";
import { cn } from "@/lib/utils";
import { client, errorText } from "@/session";
import { sevenTVSetId } from "./emojiNames";

const DEBOUNCE_MS = 300;

type Selection = Map<string, SevenTVEmote>;

/** Picks emotes from 7TV, by search or from an emote set, and hands them to onAdd to name and add. */
export function SevenTVDialog({ onAdd, onClose }: { onAdd: (emotes: SevenTVEmote[]) => void; onClose: () => void }) {
  const [selected, setSelected] = useState<Selection>(new Map());
  const toggle = (e: SevenTVEmote) => setSelected((s) => {
    const next = new Map(s);
    if (!next.delete(e.id)) next.set(e.id, e);
    return next;
  });
  const setAll = (emotes: SevenTVEmote[], on: boolean) => setSelected((s) => {
    const next = new Map(s);
    for (const e of emotes) if (on) next.set(e.id, e); else next.delete(e.id);
    return next;
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add emotes from 7TV</DialogTitle>
          <DialogDescription>Pick emotes, then name them before adding. Each is copied to this server.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="search">
          <TabsList>
            <TabsTrigger value="search">Search</TabsTrigger>
            <TabsTrigger value="set">Emote set</TabsTrigger>
          </TabsList>
          <TabsContent value="search"><SearchTab selected={selected} onToggle={toggle} /></TabsContent>
          <TabsContent value="set"><SetTab selected={selected} onToggle={toggle} onSetAll={setAll} /></TabsContent>
        </Tabs>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={selected.size === 0} onClick={() => { onAdd([...selected.values()]); onClose(); }}>
            {selected.size === 1 ? "Add 1 emote" : `Add ${selected.size} emotes`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SearchTab({ selected, onToggle }: { selected: Selection; onToggle: (e: SevenTVEmote) => void }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SevenTVEmote[]>([]);
  const [next, setNext] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");

  useEffect(() => {
    const t = setTimeout(() => { setQ(query.trim()); setPage(1); }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(undefined);
    client.searchSevenTV(q, page).then(
      (p) => {
        if (stale) return;
        const got = p.items ?? [];
        setItems((old) => (page === 1 ? got : [...old, ...got.filter((e) => !old.some((o) => o.id === e.id))]));
        setNext(p.next_page);
        setLoading(false);
      },
      (e) => { if (!stale) { setError(errorText(e)); setLoading(false); } },
    );
    return () => { stale = true; };
  }, [q, page]);

  return (
    <div className="grid gap-3">
      <Input type="search" aria-label="Search 7TV" placeholder="Search 7TV" value={query} onChange={(e) => setQuery(e.target.value)} />
      <EmoteGrid items={items} selected={selected} onToggle={onToggle} />
      {!loading && !error && items.length === 0 && <p className="text-muted-foreground">No emotes found.</p>}
      <ErrorText error={error} />
      {loading ? <Spinner className="mx-auto" /> : next && (
        <Button variant="outline" className="justify-self-center" onClick={() => setPage(next)}>Load more</Button>
      )}
    </div>
  );
}

function SetTab({ selected, onToggle, onSetAll }: {
  selected: Selection; onToggle: (e: SevenTVEmote) => void; onSetAll: (emotes: SevenTVEmote[], on: boolean) => void;
}) {
  const [link, setLink] = useState("");
  const [set, setSet] = useState<{ name: string; items: SevenTVEmote[] }>();
  const { busy, error, run } = useSubmit();
  const load = () => {
    const id = sevenTVSetId(link);
    void run(async () => {
      if (!id) throw new Error("Paste a 7TV emote set link or ID");
      const s = await client.sevenTVSet(id);
      setSet({ name: s.name, items: s.items ?? [] });
    });
  };
  const allOn = !!set && set.items.length > 0 && set.items.every((e) => selected.has(e.id));
  return (
    <div className="grid gap-3">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); load(); }}>
        <Input aria-label="7TV emote set link or ID" placeholder="https://7tv.app/emote-sets/…" value={link} onChange={(e) => setLink(e.target.value)} />
        <Button type="submit" disabled={busy || !link.trim()}>Load set</Button>
      </form>
      <ErrorText error={error} />
      {set && (
        <>
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 truncate"><span className="font-semibold">{set.name}</span>
              <span className="text-muted-foreground"> · {set.items.length} emotes</span></p>
            <Button variant="outline" size="sm" disabled={set.items.length === 0} onClick={() => onSetAll(set.items, !allOn)}>
              {allOn ? "Clear selection" : "Select all"}
            </Button>
          </div>
          <EmoteGrid items={set.items} selected={selected} onToggle={onToggle} />
        </>
      )}
    </div>
  );
}

function EmoteGrid({ items, selected, onToggle }: { items: SevenTVEmote[]; selected: Selection; onToggle: (e: SevenTVEmote) => void }) {
  if (items.length === 0) return null;
  return (
    <ul aria-label="7TV emotes" className="grid max-h-80 grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2 overflow-y-auto p-0.5">
      {items.map((e) => {
        const on = selected.has(e.id);
        return (
          <li key={e.id}>
            <Button variant="ghost" aria-pressed={on} aria-label={e.name} title={e.name} onClick={() => onToggle(e)}
              className={cn("relative grid h-auto w-full gap-1 rounded-md border p-2", on ? "border-primary bg-accent" : "border-transparent")}>
              {on && <Check aria-hidden className="absolute top-1 right-1 size-3.5 text-primary" />}
              <img src={e.preview_url} alt="" loading="lazy" className="mx-auto size-10 object-contain" />
              <span className="truncate text-xs font-normal">{e.name}</span>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
