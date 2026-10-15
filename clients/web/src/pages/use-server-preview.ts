import { unwrap, type ServerPreview } from "@datrope/core";
import { useEffect, useState } from "react";
import { useApplyAccent } from "@/hooks/use-theme";
import { client } from "../session";

/** The server as anyone may see it, and its accent applied. undefined while loading, null when there is none yet. */
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
  useApplyAccent(preview?.accent_color);
  return preview;
}

/** "March 2025" */
export function sinceLabel(createdAt: string) {
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(createdAt));
}
