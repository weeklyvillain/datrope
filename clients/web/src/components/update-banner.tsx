import { useState } from "react";
import { Button } from "@/components/ui/button";
import { clientBuild, isStale, reloadToNewBuild } from "@/lib/build";
import { cn } from "@/lib/utils";
import { useApp } from "@/session";

/** "Datrope was updated" with Reload, once the server runs a newer build than this page. */
export function UpdateBanner({ className }: { className?: string }) {
  const serverBuild = useApp((s) => s.serverBuild);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!isStale(clientBuild, serverBuild) || dismissed === serverBuild) return null;
  return (
    <div role="status" className={cn("fixed left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-border bg-card py-1 pl-4 pr-1 text-card-foreground shadow-lg", className)}>
      <span>Datrope was updated.</span>
      <Button size="sm" className="rounded-full" disabled={busy} onClick={() => { setBusy(true); void reloadToNewBuild(); }}>Reload</Button>
      <Button size="sm" variant="ghost" className="rounded-full" onClick={() => setDismissed(serverBuild)}>Later</Button>
    </div>
  );
}
