import { useState } from "react";
import { latch } from "@/lib/touch";

/** False until `open` first turns true, then true for good: lazily mounts a sheet and keeps it for its close animation. */
export function useLatch(open: boolean): boolean {
  const [ever, setEver] = useState(open);
  const now = latch(ever, open);
  if (now !== ever) setEver(now);
  return now;
}
