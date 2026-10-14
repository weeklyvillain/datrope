import { createTwitch } from "./twitch";
import type { CreatePlayer } from "./types";
import { createYouTube } from "./youtube";

/** The player for a watch's kind. */
export const createPlayer: CreatePlayer = (mount, st, start, events) =>
  (st.kind === "youtube" ? createYouTube : createTwitch)(mount, st, start, events);
