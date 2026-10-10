import type { Activity } from "@datrope/core";
import { BrandIcon } from "@/lib/brand-icons";
import { cn } from "@/lib/utils";
import { useApp } from "@/session";

/** What a person is doing on a linked account, if anything. */
export const useActivity = (userId: string) => useApp((s): Activity | undefined => s.activities[userId]);

/** One line: "Live on Twitch: title" or "Listening to song · artists". */
export function activityText(a: Activity): string {
  if (a.type === "streaming") return `Live on Twitch${a.title ? `: ${a.title}` : ""}`;
  return `Listening to ${a.title}${a.detail ? ` · ${a.detail}` : ""}`;
}

/** The short line under a name in lists. */
export function ActivityLine({ activity, className }: { activity: Activity; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1", activity.type === "streaming" && "text-destructive", className)}>
      <BrandIcon slug={activity.platform} className="size-3 flex-none" />
      <span className="truncate">{activityText(activity)}</span>
    </span>
  );
}

/** The card on a profile, with a link to watch or listen. */
export function ActivityCard({ activity }: { activity: Activity }) {
  const live = activity.type === "streaming";
  return (
    <a href={activity.url} target="_blank" rel="noopener noreferrer"
      className="flex items-center gap-3 rounded-lg border bg-card p-2.5 text-foreground no-underline hover:bg-accent">
      <BrandIcon slug={activity.platform} className={cn("size-6 flex-none", live ? "text-destructive" : "text-muted-foreground")} />
      <span className="grid min-w-0 gap-0.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{live ? "Live on Twitch" : "Listening on Spotify"}</span>
        <span className="truncate text-sm font-medium">{activity.title || (live ? "Streaming" : "Something")}</span>
        {activity.detail && <span className="truncate text-xs text-muted-foreground">{activity.detail}</span>}
      </span>
    </a>
  );
}
