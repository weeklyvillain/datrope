import { unwrap, type ServerPreview } from "@datrope/core";
import { useEffect, useState } from "react";
import { useApplyPalette } from "@/hooks/use-palette";
import { client } from "../session";

/** The server as anyone may see it, and its palette applied. undefined while loading, null when there is none yet. */
export function useServerPreview() {
  const [preview, setPreview] = useState<ServerPreview | null>();
  useEffect(() => {
    let cancelled = false;
    unwrap(client.api.GET("/api/server/preview"))
      .then((p) => !cancelled && setPreview(p))
      .catch(() => !cancelled && setPreview(null));
    return () => {
      cancelled = true;
    };
  }, []);
  useApplyPalette(preview?.palette);
  return preview;
}

/** "March 2025" */
export function sinceLabel(createdAt: string) {
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(createdAt));
}
