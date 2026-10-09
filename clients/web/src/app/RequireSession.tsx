import { unwrap } from "@datrope/core";
import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { client, savedPresence, useApp } from "../session";

/** Checks the session, then opens the gateway for everything below it. */
export function RequireSession() {
  const nav = useNavigate();
  const loc = useLocation();
  const [checked, setChecked] = useState(false);
  const ready = useApp((s) => s.me !== null);

  useEffect(() => {
    let cancelled = false;
    unwrap(client.api.GET("/api/users/@me"))
      .then(() => {
        if (cancelled) return;
        setChecked(true);
        client.connect(savedPresence());
      })
      .catch(() => {
        if (!cancelled) nav(`/login?next=${encodeURIComponent(loc.pathname)}`, { replace: true });
      });
    return () => {
      cancelled = true;
      client.disconnect();
    };
    // Run once per mount; navigation inside the app must not reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!checked || !ready) return <div className="grid min-h-full place-items-center p-8 text-center text-muted-foreground">Connecting…</div>;
  return <Outlet />;
}
