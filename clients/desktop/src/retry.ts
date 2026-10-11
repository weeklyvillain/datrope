const BACKOFF = [5, 10, 20, 40];

/** Seconds the offline page waits before its automatic retry number `attempt` (0-based): 5, 10, 20, 40, then 60. */
export function retryDelay(attempt: number): number {
  return BACKOFF[attempt] ?? 60;
}
