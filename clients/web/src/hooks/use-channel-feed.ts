import { useEffect, useState } from "react";
import { client, errorText, useApp } from "@/session";

/** Loads a channel's first page of messages (again if a fresh READY cleared it). Returns the load
 *  error, if any. MessageList marks the channel read when its bottom is in view. */
export function useChannelFeed(channelId: string): string | undefined {
  const loaded = useApp((s) => !!s.messages[channelId]);
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    if (!loaded) client.loadOlder(channelId).catch((e) => setLoadError(errorText(e)));
  }, [channelId, loaded]);

  return loadError;
}
