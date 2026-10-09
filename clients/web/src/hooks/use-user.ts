import { findUser, type PublicUser } from "@datrope/core";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/session";

/** A person's live profile from the store, else the snapshot the caller has (e.g. a message's author). */
export function useUser(userId: string, fallback?: PublicUser): PublicUser | undefined {
  // useShallow: findUser builds a fresh object for me, which would otherwise never settle.
  return useApp(useShallow((s) => findUser(s, userId))) ?? fallback;
}
