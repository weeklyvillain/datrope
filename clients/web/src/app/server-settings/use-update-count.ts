import { unwrap } from "@datrope/core";
import { useEffect, useState } from "react";
import { updatesAvailable } from "@/lib/system";
import { client } from "@/session";

/** How many updates are waiting, for the settings nav badge (admins only; 0 otherwise). */
export function useUpdateCount(enabled: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    unwrap(client.api.GET("/api/admin/system/updates"))
      .then((u) => { if (live) setN(updatesAvailable(u)); })
      .catch(() => {});
    return () => { live = false; };
  }, [enabled]);
  return n;
}
