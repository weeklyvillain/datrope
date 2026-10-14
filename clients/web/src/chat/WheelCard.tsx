import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { reelLayout, type Wheel } from "./wheel";

const TILE_BG = ["bg-avatar-1", "bg-avatar-2", "bg-avatar-3", "bg-avatar-4", "bg-avatar-5", "bg-avatar-6", "bg-avatar-7", "bg-avatar-8"];
const FRESH_MS = 10_000; // a message younger than this spins; older ones show where it landed
const SPIN_MS = 4500;
// Messages that already spun here, so scrolling back (the list remounts rows) doesn't spin them again.
const spun = new Set<string>();

type Phase = "start" | "spinning" | "done";

/** A /wheel message: a reel of the options that races past a marker and stops on the winner. */
export function WheelCard({ id, wheel, createdAt, pending }: { id: string; wheel: Wheel; createdAt: string; pending?: boolean }) {
  const [layout] = useState(() => reelLayout(wheel, Math.random()));
  const [phase, setPhase] = useState<Phase>(() => {
    if (pending) return "start";
    const fresh = Date.now() - Date.parse(createdAt) < FRESH_MS;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    return fresh && !still && !spun.has(id) ? "start" : "done";
  });

  useEffect(() => {
    if (pending || phase === "done") return;
    if (phase === "spinning") {
      const done = setTimeout(() => setPhase("done"), SPIN_MS);
      return () => clearTimeout(done);
    }
    spun.add(id);
    // Two frames: the start position must be painted before the transition to the end begins.
    let raf = requestAnimationFrame(() => (raf = requestAnimationFrame(() => setPhase("spinning"))));
    return () => cancelAnimationFrame(raf);
  }, [id, pending, phase]);

  const winner = wheel.options[wheel.winner]!;
  const at = phase === "start" ? layout.start : layout.end;

  return (
    <section aria-label="Wheel spin" className="mt-1.5 w-full max-w-lg overflow-hidden rounded-lg border bg-card">
      <header className="flex items-center gap-2 border-b px-3 py-2.5 text-ui text-muted-foreground">
        🎡 <span className="font-semibold text-foreground">Spin the wheel</span> · {wheel.options.length} options
      </header>
      <div aria-hidden className="relative h-18 overflow-hidden bg-sidebar">
        <div
          className="absolute top-3 left-1/2 flex gap-2"
          style={{
            transform: `translateX(${-at}rem)`,
            transition: phase === "spinning" ? `transform ${SPIN_MS}ms cubic-bezier(0.1, 0.8, 0.2, 1)` : undefined,
          }}>
          {layout.tiles.map((option, i) => (
            <div
              key={i}
              className={cn(
                "grid h-12 w-32 flex-none place-items-center rounded-md px-2 text-ui font-semibold text-foreground",
                TILE_BG[option % TILE_BG.length],
                phase === "done" && i === layout.winnerTile && "outline-2 -outline-offset-2 outline-primary",
              )}>
              <span className="w-full truncate text-center">{wheel.options[option]}</span>
            </div>
          ))}
        </div>
        <div className="pointer-events-none absolute inset-y-0 left-0 w-20 bg-linear-to-r from-sidebar to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-20 bg-linear-to-l from-sidebar to-transparent" />
        <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-primary shadow-[0_0_8px_var(--primary)]" />
      </div>
      <p aria-live="polite" className="m-0 flex items-center gap-2 px-3 py-2.5 text-ui">
        {phase === "done" ? (
          <><span className="text-muted-foreground">Landed on</span><span className="font-bold text-foreground wrap-anywhere">{winner}</span></>
        ) : (
          <span className="text-muted-foreground">Spinning…</span>
        )}
      </p>
    </section>
  );
}
