import { clearOperators, operatorValue, type ChannelRef, type SearchFilters, type SearchResult } from "@datrope/core";
import { Search } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { client, displayName, dmName, errorText, roleColor, useApp } from "../../session";
import { Markdown } from "@/chat/Markdown";
import { ErrorText } from "@/components/error-text";
import { UserAvatar } from "@/components/user-avatar";
import { WebhookAvatar } from "@/components/webhook-avatar";
import { Button } from "@/components/ui/button";
import { useMessageAuthor } from "@/hooks/use-message-author";
import { cn } from "@/lib/utils";
import { openMessage } from "../jump";
import { stamp } from "../MessageList";
import { closePanel, panelStore, setSearchQuery, usePanel } from "../side-panel/panel";
import { SidePanel } from "../side-panel/SidePanel";
import { WebhookBadge } from "../WebhookAuthor";
import { SearchChips } from "./SearchChips";
import { clearSearchResults, resultsStore, setSearchResults, updateSearchResults, useSearchResults } from "./results";

/** Nothing to search for yet: empty, or only operators without a value (the hint just inserted "in:#"). */
const isBlank = (q: string) => q.split(/\s+/).every((t) => !t || /^(from|in|has|before|after):[#@]?$/i.test(t));
const hasOperators = (q: string) => /(^|\s)(from|in|has|before|after):/i.test(q);

/** Search results in the side panel. It searches when it opens and again whenever the query changes
 *  (typing is debounced; chips and "Clear filters" apply at once). The results live in a module store,
 *  so switching channels (which remounts the panel) keeps them, their pages and the scroll position. */
export function SearchPanel() {
  const query = usePanel((s) => s.query).trim();
  const navigate = useNavigate();
  const results = useSearchResults();
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [moreError, setMoreError] = useState<string>();
  const latest = useRef(0); // only the newest search may set the results
  const now = useRef(true); // the next search runs without the debounce (opening, chips)
  const scroller = useRef<HTMLDivElement>(null);
  const scrollTop = useRef(0);

  // Back from another channel: restore the scroll position, and save it when leaving.
  useLayoutEffect(() => {
    const saved = resultsStore.getState().results;
    if (saved?.query === query && scroller.current) scroller.current.scrollTop = saved.scrollTop;
    scrollTop.current = saved?.scrollTop ?? 0;
    return () => updateSearchResults({ scrollTop: scrollTop.current });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const n = ++latest.current;
    setError(undefined);
    if (isBlank(query)) {
      clearSearchResults();
      setLoading(false);
      return;
    }
    if (resultsStore.getState().results?.query === query) { // already searched (e.g. before a channel switch)
      now.current = false;
      setLoading(false);
      return;
    }
    const delay = now.current ? 0 : 250;
    setLoading(true);
    const t = setTimeout(() => {
      now.current = false;
      client.search(query).then((r) => {
        if (n !== latest.current) return;
        setSearchResults({ query, filters: r.filters, total: r.total, items: r.results ?? [], next: r.next_cursor, scrollTop: 0 });
        setMoreError(undefined);
        setLoading(false);
        scroller.current?.scrollTo({ top: 0 });
      }, (e) => {
        if (n !== latest.current) return;
        setError(errorText(e));
        setLoading(false);
      });
    }, delay);
    return () => clearTimeout(t);
  }, [query]);

  const apply = (q: string) => {
    if (q.trim() === panelStore.getState().query.trim()) return; // nothing changes: no search to hurry
    now.current = true;
    setSearchQuery(q);
  };

  const loadMore = async () => {
    if (!results?.next) return;
    const n = latest.current;
    setLoadingMore(true);
    setMoreError(undefined);
    try {
      const r = await client.search(results.query, results.next);
      if (n !== latest.current || resultsStore.getState().results?.query !== results.query) return;
      updateSearchResults({ items: [...resultsStore.getState().results!.items, ...(r.results ?? [])], next: r.next_cursor });
    } catch (e) {
      if (n === latest.current) setMoreError(errorText(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const current = results?.query === query ? results : undefined;
  // While a new search runs, the previous results stay, dimmed.
  const shown = current ?? (loading ? results ?? undefined : undefined);
  const count = current?.total ?? current?.items.length ?? 0;
  const heading = isBlank(query) || (error && !loading) ? "Search"
    : loading || !current ? "Searching…"
    : count === 0 ? "No results"
    : count > 1000 ? "1000+ results"
    : count === 1 ? "1 result" : `${count} results`;

  return (
    <SidePanel title={heading} label="Search results" closeLabel="Close search" icon={<Search />}
      onClose={() => {
        clearSearchResults();
        closePanel();
      }}>
      <SearchChips query={query} filters={loading ? undefined : current?.filters} onChange={apply} />
      <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto py-2"
        onScroll={(e) => { scrollTop.current = e.currentTarget.scrollTop; }}>
        {isBlank(query) ? (
          <p className="m-0 p-6 text-center text-sm text-muted-foreground">Type something to search for.</p>
        ) : error && !loading ? (
          <div className="px-4"><ErrorText error={error} /></div>
        ) : !shown ? (
          null
        ) : shown.items.length === 0 ? (
          !loading && <NoResults query={query} filters={shown.filters} onClear={() => apply(clearOperators(query))} />
        ) : (
          <div className={cn("contents", loading && "[&>*]:opacity-60")}>
            {shown.items.map((r, i) => (
              <Fragment key={r.message.id}>
                {r.channel.id !== shown.items[i - 1]?.channel.id && <GroupLabel where={r.channel} first={i === 0} />}
                <ResultRow result={r} terms={shown.filters.terms ?? []} active={shown.opened === r.message.id}
                  onOpen={() => {
                    updateSearchResults({ opened: r.message.id });
                    openMessage(navigate, r.channel, r.message.id);
                  }} />
              </Fragment>
            ))}
            {loading ? null : shown.next ? (
              <div className="px-2 pt-2">
                <Button variant="outline" className="w-full" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? "Loading…" : "Load more"}
                </Button>
                <ErrorText error={moreError} />
              </div>
            ) : (
              <p className="m-0 px-4 pt-3.5 text-center text-xs text-muted-foreground">No more results</p>
            )}
          </div>
        )}
      </div>
    </SidePanel>
  );
}
function NoResults({ query, filters, onClear }: { query: string; filters: SearchFilters; onClear: () => void }) {
  const terms = filters.terms ?? [];
  const fromName = filters.from ? displayName(filters.from) : operatorValue(query, "from");
  const text = (terms.length > 0 ? `Nothing matches "${terms.join(" ")}"` : "Nothing matches these filters")
    + (fromName && terms.length > 0 ? ` from ${fromName}` : "") + ".";
  return (
    <div className="px-6 py-8 text-center">
      <p className="m-0 mb-3 text-sm text-muted-foreground">{text}</p>
      {hasOperators(query) && <Button variant="outline" size="sm" onClick={onClear}>Clear filters</Button>}
    </div>
  );
}

/** "#general", "#general › Saturday plans" for a thread, or the DM's name. */
function GroupLabel({ where, first }: { where: ChannelRef; first: boolean }) {
  const name = useApp((s) => (where.type === "dm" ? (s.channels[where.id] ? dmName(s.channels[where.id], s.me?.id) : "Direct message") : undefined));
  const label = where.type === "thread" ? `#${where.parent_name ?? ""} › ${where.name}` : where.type === "dm" ? name : `#${where.name}`;
  return <p className={cn("m-0 truncate px-4 text-xs text-muted-foreground", first ? "pt-1" : "pt-2.5")}>{label}</p>;
}

function ResultRow({ result, terms, active, onOpen }: { result: SearchResult; terms: string[]; active: boolean; onOpen: () => void }) {
  const m = result.message;
  const author = useMessageAuthor(m);
  const color = useApp((s) => (result.channel.type === "dm" || !m.author ? undefined : roleColor(s.server, m.author.id)));
  const file = m.attachments?.[0]?.filename;
  const nameId = `sr-name-${m.id}`;
  const textId = `sr-text-${m.id}`;
  return (
    <button type="button" onClick={onOpen} aria-labelledby={`${nameId} ${textId}`}
      className={cn("mx-2 flex gap-2.5 rounded-lg border border-transparent p-2 text-left outline-none hover:border-border hover:bg-background focus-visible:ring-[3px] focus-visible:ring-ring/50",
        active && "border-border bg-background")}>
      {m.author ? <UserAvatar user={author} size="md" /> : <WebhookAvatar avatarUrl={m.webhook?.avatar_url} size="md" />}
      <span className="block min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span id={nameId} className="truncate text-sm font-semibold" style={{ color }}>{displayName(author)}</span>
          {!m.author && <WebhookBadge />}
          <time className="flex-none text-xs text-muted-foreground" dateTime={m.created_at}>{stamp(new Date(m.created_at))}</time>
        </span>
        {m.content ? (
          <span id={textId} className="line-clamp-3 block text-sm wrap-anywhere">
            <Markdown text={m.content} inline highlight={terms} mentions={m.mentions ?? undefined} />
          </span>
        ) : m.poll ? (
          <span id={textId} className="block truncate text-sm text-muted-foreground">Poll: {m.poll.question}</span>
        ) : file ? (
          <span id={textId} className="block truncate text-sm text-muted-foreground">📎 {file}</span>
        ) : null}
      </span>
    </button>
  );
}
