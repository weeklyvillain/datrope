import { ChevronDown, ChevronUp } from "lucide-react";
import { useRef, type KeyboardEvent, type WheelEvent } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const STEP_PX = 50; // scroll distance per item: a mouse notch moves one or two, trackpad inertia can't spin the wheel away

/** Adds a wheel delta to what has built up and returns the whole steps to move and the remainder.
 *  Turning the other way drops what had built up. */
export function wheelSteps(built: number, delta: number): { steps: number; rest: number } {
  const total = Math.sign(built) === -Math.sign(delta) ? delta : built + delta;
  const steps = Math.trunc(total / STEP_PX);
  return { steps, rest: total - steps * STEP_PX };
}

/** A scroll wheel: the chosen item between its neighbours. Arrow keys, the mouse wheel and the neighbours move it. */
export function Wheel({ label, items, index, onChange, className }:
  { label: string; items: string[]; index: number; onChange: (i: number) => void; className?: string }) {
  const go = (i: number) => onChange(Math.min(items.length - 1, Math.max(0, i)));
  const keys = (e: KeyboardEvent) => {
    const step = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 }[e.key];
    if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (step) go(index + step);
    else return;
    e.preventDefault();
  };
  const built = useRef(0);
  const wheel = (e: WheelEvent) => {
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; // lines (Firefox) to pixels
    const { steps, rest } = wheelSteps(built.current, px);
    built.current = rest;
    if (steps) go(index + steps);
  };
  return (
    <div role="spinbutton" tabIndex={0} aria-label={label} aria-valuemin={0} aria-valuemax={items.length - 1}
      aria-valuenow={index} aria-valuetext={items[index]} onKeyDown={keys} onWheel={wheel}
      className={cn("flex w-16 flex-col items-stretch overflow-hidden rounded-lg border text-center tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}>
      <Button variant="ghost" tabIndex={-1} aria-hidden className="h-auto w-full rounded-none px-0 py-1 text-sm font-normal text-muted-foreground hover:bg-transparent hover:text-foreground focus-visible:ring-0" onClick={() => go(index - 1)}>
        {items[index - 1] ?? <ChevronUp className="mx-auto size-4 opacity-40" />}
      </Button>
      <span className="bg-accent py-1.5 text-title font-semibold text-foreground">{items[index]}</span>
      <Button variant="ghost" tabIndex={-1} aria-hidden className="h-auto w-full rounded-none px-0 py-1 text-sm font-normal text-muted-foreground hover:bg-transparent hover:text-foreground focus-visible:ring-0" onClick={() => go(index + 1)}>
        {items[index + 1] ?? <ChevronDown className="mx-auto size-4 opacity-40" />}
      </Button>
    </div>
  );
}
