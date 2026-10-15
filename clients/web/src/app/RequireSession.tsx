import { unwrap } from "@datrope/core";
import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { isUnreachable } from "@/lib/error-kind";
import { ServerUnreachable } from "../pages/errors";
import { client, savedPresence, useApp } from "../session";

/** Checks the session, then opens the gateway for everything below it. */
export function RequireSession() {
  const nav = useNavigate();
  const loc = useLocation();
  const [checked, setChecked] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const check = useRef<() => Promise<void>>(async () => {});
  const ready = useApp((s) => s.me !== null);

  useEffect(() => {
    let cancelled = false;
    check.current = () => unwrap(client.api.GET("/api/users/@me"))
      .then(() => {
        if (cancelled) return;
        setUnreachable(false);
        setChecked(true);
        client.connect(savedPresence());
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // No answer (or a proxy's 5xx) is not a reason to sign in again: wait for the server instead.
        if (isUnreachable(e)) setUnreachable(true);
        else nav(`/login?next=${encodeURIComponent(loc.pathname)}`, { replace: true });
      });
    void check.current();
    return () => {
      cancelled = true;
      client.disconnect();
    };
    // Run once per mount; navigation inside the app must not reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (unreachable) return <ServerUnreachable retry={() => check.current()} />;
  if (!checked || !ready) return <div className="grid min-h-full place-items-center p-8 text-center text-muted-foreground">Connecting…</div>;
  return <Outlet />;
}
