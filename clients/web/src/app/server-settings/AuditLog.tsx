import { unwrap, type AuditEntry, type PublicUser } from "@datrope/core";
import { useEffect, useRef, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { UserAvatar } from "@/components/user-avatar";
import { Button } from "@/components/ui/button";
import { describe, detailLines } from "@/lib/audit";
import { client, displayName, errorText } from "@/session";

const PAGE = 50;

/** What moderators and admins changed, newest first (VIEW_AUDIT_LOG). Older entries load as the list scrolls to its end. */
export function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>();
  const [users, setUsers] = useState<Record<string, PublicUser>>({});
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const end = useRef<HTMLDivElement>(null);
  const busy = useRef(false);

  const load = async (before?: string) => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setError(undefined);
    try {
      const page = await unwrap(client.api.GET("/api/server/audit-log", { params: { query: { before, limit: PAGE } } }));
      const got = page.entries ?? [];
      setEntries((prev) => [...(before ? prev ?? [] : []), ...got]);
      setUsers((prev) => ({ ...prev, ...page.users }));
      setMore(got.length === PAGE);
    } catch (e) {
      setError(errorText(e));
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };
  const loadOlder = () => void load(entries?.at(-1)?.id);

  useEffect(() => void load(), []);

  useEffect(() => {
    const el = end.current;
    if (!el || !more || error || !entries?.length) return;
    const io = new IntersectionObserver((xs) => xs[0]?.isIntersecting && loadOlder());
    io.observe(el);
    return () => io.disconnect();
  }); // re-armed each render: it must see the latest entries

  if (entries?.length === 0) return <><ErrorText error={error} /><p className="text-muted-foreground">Nothing has been recorded yet.</p></>;
  return (
    <>
      <p className="text-sm text-muted-foreground">Entries are kept for 90 days.</p>
      <ol aria-label="Audit log" className="grid gap-px overflow-hidden rounded-lg border bg-border">
        {entries?.map((e) => {
          const actor = users[e.actor_id];
          const lines = detailLines(e);
          return (
            <li key={e.id} className="flex gap-3 bg-card px-4 py-3">
              {actor ? <UserAvatar user={actor} size="md" /> : <span className="size-8 flex-none rounded-full bg-muted" aria-hidden />}
              <div className="min-w-0 flex-1">
                <p className="m-0">
                  <strong className="font-semibold">{actor ? displayName(actor) : "Unknown user"}</strong>{" "}
                  {describe(e, users).map((p, i) => typeof p === "string" ? p : <strong key={i} className="font-semibold">{p.strong}</strong>)}
                </p>
                {lines.length > 0 && (
                  <ul className="m-0 mt-1 list-none p-0 text-sm break-words text-muted-foreground">
                    {lines.map((l, i) => <li key={i}>{l}</li>)}
                  </ul>
                )}
              </div>
              <time dateTime={e.created_at} title={new Date(e.created_at).toLocaleString()}
                className="flex-none text-xs whitespace-nowrap text-muted-foreground">
                {new Date(e.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
              </time>
            </li>
          );
        })}
      </ol>
      <ErrorText error={error} />
      <div ref={end}>
        {more && entries && (
          <Button variant="outline" className="w-full" disabled={loading} onClick={loadOlder}>{loading ? "Loading…" : "Load older entries"}</Button>
        )}
      </div>
    </>
  );
}
