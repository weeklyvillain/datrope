import { useEffect, useState } from "react";
import { timeLeft } from "@/lib/guest";
import { useApp } from "../session";

/** For guests: how long their access lasts. Updates every minute. */
export function GuestBanner() {
  const expires = useApp((s) => s.me?.guest_expires_at);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expires) return;
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [expires]);
  if (!expires) return null;
  return (
    <div role="status" data-guest-banner className="border-b border-border bg-card px-4 pt-[calc(0.375rem+env(safe-area-inset-top,0px))] pb-1.5 text-center text-sm text-muted-foreground">
      You're a guest. Access ends in {timeLeft(new Date(expires).getTime() - now)}.
    </div>
  );
}
