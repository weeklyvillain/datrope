import { unwrap, type Attachment, type GIF } from "@datrope/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { appendUnique, attachError, masonry, requestTickets } from "@/chat/gifs";
import { client } from "@/session";

const COLUMNS = 3;
const DEBOUNCE_MS = 300;

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

type Results = { items: GIF[]; next?: string; loading: boolean; failed: boolean };

/** Search results (trending for an empty query), page by page. Only the newest request's answer is used. */
function useGifResults(query: string) {
  const [results, setResults] = useState<Results>({ items: [], loading: true, failed: false });
  const [tickets] = useState(requestTickets);
  const load = useCallback((pos?: string) => {
    const ticket = pos ? tickets.current() : tickets.renew();
    setResults((r) => (pos ? { ...r, loading: true, failed: false } : { items: [], loading: true, failed: false }));
    const q = query.trim();
    const page = q
      ? unwrap(client.api.GET("/api/gifs/search", { params: { query: pos ? { q, pos } : { q } } }))
      : unwrap(client.api.GET("/api/gifs/trending", { params: { query: pos ? { pos } : {} } }));
    page.then(
      (p) => {
        if (!tickets.isNewest(ticket)) return;
        setResults((r) => ({ items: appendUnique(pos ? r.items : [], p.items ?? []), next: p.next, loading: false, failed: false }));
      },
      () => {
        if (tickets.isNewest(ticket)) setResults((r) => ({ ...r, loading: false, failed: true }));
      },
    );
  }, [query, tickets]);
  useEffect(() => load(), [load]);
  return { ...results, load };
}

/** Calls onVisible once it scrolls into view, or on mount if it is already visible. */
function Sentinel({ onVisible }: { onVisible: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(onVisible);
  latest.current = onVisible;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) latest.current();
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} aria-hidden="true" className="h-px" />;
}

function GifGrid({ items, onChoose }: { items: GIF[]; onChoose: (g: GIF) => void }) {
  return (
    <div className="grid grid-cols-3 items-start gap-1.5">
      {masonry(items, COLUMNS).map((column, i) => (
        <div key={i} className="grid gap-1.5">
          {column.map((g) => (
            <Button key={g.id} variant="ghost" className="h-auto w-full overflow-hidden rounded-md p-0"
              aria-label={g.title || "GIF"} title={g.title} onClick={() => onChoose(g)}>
              <img src={g.preview_url} alt="" loading="lazy" width={g.width} height={g.height} className="block h-auto w-full bg-muted" />
            </Button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** `/gif [query]`: search Klipy, preview a GIF, add a caption, send. The server stores
 *  the GIF (attach); the caller then posts the message and closes the dialog. */
export function GifDialog({ channelId, query: initial, onPick, onClose }: {
  channelId: string; query: string; onPick: (attachment: Attachment, caption: string) => void; onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const query = useDebounced(text.trim(), DEBOUNCE_MS);
  const results = useGifResults(query);
  const [chosen, setChosen] = useState<GIF | null>(null);
  const [caption, setCaption] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string>();

  const choose = (g: GIF) => {
    setChosen(g);
    setCaption("");
    setSendError(undefined);
  };
  const send = () => {
    if (!chosen || sending) return;
    setSending(true);
    setSendError(undefined);
    unwrap(client.api.POST("/api/gifs/{id}/attach", { params: { path: { id: chosen.id }, query: { channel_id: channelId } } }))
      .then((a) => onPick(a, caption.trim()))
      .catch((e: unknown) => {
        setSendError(attachError(e)); // the dialog stays open
        setSending(false);
      });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !sending && onClose()}>
      <DialogContent aria-describedby={undefined} className="flex max-h-[85vh] flex-col sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Send a GIF</DialogTitle>
        </DialogHeader>
        {chosen ? (
          <form className="grid min-h-0 gap-3" onSubmit={(e) => {
            e.preventDefault();
            send();
          }}>
            <img src={chosen.preview_url} alt={chosen.title || "GIF"} width={chosen.width} height={chosen.height}
              className="mx-auto max-h-[50vh] w-auto max-w-full rounded-md bg-muted" />
            <FormField label="Caption" placeholder="Add a caption (optional)" maxLength={4000} autoFocus
              value={caption} onChange={(e) => setCaption(e.target.value)} />
            <ErrorText error={sendError} />
            <DialogFooter>
              <Button variant="outline" disabled={sending} onClick={() => setChosen(null)}>Back</Button>
              <Button type="submit" disabled={sending}>Send</Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <Input aria-label="Search GIFs" placeholder="Search KLIPY" value={text} maxLength={100} autoFocus
              onChange={(e) => setText(e.target.value)} />
            <div className="min-h-[200px] flex-1 overflow-y-auto">
              <GifGrid items={results.items} onChoose={choose} />
              {results.failed && (
                <div className="grid justify-items-center gap-2 py-6">
                  <ErrorText error="Couldn't load GIFs" />
                  <Button variant="outline" onClick={() => results.load(results.items.length > 0 ? results.next : undefined)}>Retry</Button>
                </div>
              )}
              {results.loading && <p role="status" className="py-6 text-center text-muted-foreground">Loading…</p>}
              {!results.loading && !results.failed && results.items.length === 0 && (
                <p className="py-6 text-center text-muted-foreground">No GIFs found</p>
              )}
              {results.next && !results.loading && !results.failed && (
                <Sentinel key={results.next} onVisible={() => results.load(results.next)} />
              )}
            </div>
          </>
        )}
        <p className="text-right text-xs text-muted-foreground">Powered by KLIPY</p>
      </DialogContent>
    </Dialog>
  );
}
