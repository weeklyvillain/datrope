import { LockIcon, SearchXIcon, TriangleAlertIcon, WifiOffIcon } from "@/components/icons";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useRouteError } from "react-router-dom";
import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { errorKind } from "@/lib/error-kind";
import { EmptyView } from "../app/EmptyView";

/** In the app shell an error page fills the content column, so the sidebar still works; outside it, the whole window. */
function Frame({ inShell, children }: { inShell?: boolean; children: ReactNode }) {
  if (inShell) return <EmptyView>{children}</EmptyView>;
  return <main className="grid min-h-dvh place-items-center bg-background px-6 pt-safe pb-safe">{children}</main>;
}

const home = <Button asChild variant="secondary"><Link to="/">Go home</Link></Button>;

export function NotFound({ inShell }: { inShell?: boolean }) {
  return (
    <Frame inShell={inShell}>
      <ErrorState icon={<SearchXIcon />} title="Nothing here" actions={home}>
        This page doesn't exist. The link may be old or mistyped.
      </ErrorState>
    </Frame>
  );
}

export function NoAccess({ inShell }: { inShell?: boolean }) {
  return (
    <Frame inShell={inShell}>
      <ErrorState icon={<LockIcon />} title="You can't open this" actions={home}>
        It was deleted, or you don't have access to it. Ask an admin if you think you should.
      </ErrorState>
    </Frame>
  );
}

export function Crash({ inShell }: { inShell?: boolean }) {
  return (
    <Frame inShell={inShell}>
      <ErrorState danger icon={<TriangleAlertIcon />} title="Something broke"
        actions={<Button onClick={() => window.location.reload()}>Reload</Button>}>
        Datrope hit an error it couldn't recover from. Reloading usually fixes it.
      </ErrorState>
    </Frame>
  );
}

const BACKOFF = [5, 10, 20, 40];

/** Seconds before automatic retry number `attempt` (0-based): 5, 10, 20, 40, then 60. */
export const retryDelay = (attempt: number) => BACKOFF[attempt] ?? 60;

/** The server didn't answer. Retries `retry` on a backoff, when the network comes back, or on demand. */
export function ServerUnreachable({ retry }: { retry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(retryDelay(0));
  const attempts = useRef(0);

  const run = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await retry();
    } finally {
      attempts.current += 1;
      setLeft(retryDelay(attempts.current));
      setBusy(false);
    }
  }, [busy, retry]);

  useEffect(() => {
    if (busy) return;
    if (left <= 0) {
      void run();
      return;
    }
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [busy, left, run]);

  useEffect(() => {
    const online = () => void run();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [run]);

  return (
    <Frame>
      <ErrorState icon={<WifiOffIcon />} title={`Can't reach ${window.location.host}`}
        actions={<>
          <Button onClick={() => void run()} disabled={busy}>{busy ? "Trying…" : "Retry"}</Button>
          <p role="status" className="text-muted-foreground">{busy ? "" : `Retrying in ${left} s…`}</p>
        </>}>
        Check your connection, or whether the server is running.
      </ErrorState>
    </Frame>
  );
}

/** A route's `errorElement`: the page that fits what the route threw. */
export function RouteError({ inShell }: { inShell?: boolean }) {
  const kind = errorKind(useRouteError());
  if (kind === "not-found") return <NotFound inShell={inShell} />;
  if (kind === "no-access") return <NoAccess inShell={inShell} />;
  return <Crash inShell={inShell} />;
}
