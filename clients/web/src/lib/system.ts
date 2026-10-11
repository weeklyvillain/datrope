import { ApiError, type GitStatus, type SystemUpdates, type UpdateJobLog } from "@datrope/core";

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** 1536 -> "1.5 KB": one decimal below 10, none above. */
export function formatBytes(n: number): string {
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  const s = i === 0 || n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, "");
  return `${s} ${UNITS[i]}`;
}

/** The two largest units: "3d 4h", "4h 12m", "12m". */
export function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** SVG polyline points for values in [0, max], spread over width, 0 at the bottom. */
export function sparklinePoints(values: number[], max: number, width: number, height: number): string {
  if (values.length < 2 || max <= 0) return "";
  const step = width / (values.length - 1);
  return values
    .map((v, i) => {
      const y = height - (Math.min(Math.max(v, 0), max) / max) * height;
      return `${+(i * step).toFixed(2)},${+y.toFixed(2)}`;
    })
    .join(" ");
}

/** The containers run an older commit than the checkout, e.g. after a failed build. */
export function needsRebuild(s: GitStatus | undefined): boolean {
  return !!s?.deployed && !!s.current && s.deployed !== s.current;
}

/** How many things can be updated (for the nav badge). */
export function updatesAvailable(u: SystemUpdates): number {
  let n = 0;
  if ((u.server.status?.behind ?? 0) > 0 || needsRebuild(u.server.status)) n++;
  const y = u.ytdlp;
  if (!y.pinned && y.latest && y.installed && y.latest !== y.installed) n++;
  return n;
}

export type JobPhase = "running" | "restarting" | "succeeded" | "failed";
/** sha: the commit the stack runs after a successful update, once the status is refreshed. */
export interface JobView { phase: JobPhase; lines: string[]; next: number; message?: string; sha?: string }
export type PollResult = { log: UpdateJobLog } | { transient: true } | { error: string };

/**
 * Sorts a failed log poll. The server goes away while the update restarts it, so network errors
 * and a bad gateway or unreachable updater are transient; anything else will not fix itself.
 */
export function classifyPollError(e: unknown): { transient: true } | { error: string } {
  if (!(e instanceof ApiError)) return { transient: true };
  if (e.code === "UPDATER_NOT_CONFIGURED") return { error: e.message };
  if (e.status === 502 || e.status === 503 || e.status === 504) return { transient: true };
  if (e.status === 404) return { error: "The update log is no longer available." };
  return { error: e.message };
}

/** Folds one poll of the update log into what the page shows; finished jobs stay put. */
export function nextPoll(prev: JobView, result: PollResult): JobView {
  if (prev.phase === "succeeded" || prev.phase === "failed") return prev;
  if ("transient" in result) return { ...prev, phase: "restarting" };
  if ("error" in result) return { ...prev, phase: "failed", message: result.error };
  const { log } = result;
  const s = log.job.status;
  const phase: JobPhase = s === "succeeded" ? "succeeded" : s === "failed" ? "failed" : "running";
  return { phase, lines: [...prev.lines, ...(log.lines ?? [])], next: log.next };
}
