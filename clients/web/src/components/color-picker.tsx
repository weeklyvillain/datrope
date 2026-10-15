import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { fromHsv, normalizeHex, toHsv, type Hsv } from "@/lib/color";

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** Saturation/brightness area, hue slider and hex field. The area's black and white are the HSV model itself. */
export function ColorPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [hsv, setHsv] = useState<Hsv>(() => toHsv(value));
  // The latest colour, for events that arrive faster than renders (a held arrow key, pointer moves).
  const latest = useRef(hsv);
  latest.current = hsv;
  const [text, setText] = useState(value);
  // A new value from outside (a preset, the hex field): follow it, unless it is what we just produced.
  useEffect(() => {
    setHsv((cur) => (fromHsv(cur) === value ? cur : toHsv(value)));
    setText(value);
  }, [value]);

  const set = (next: Hsv) => {
    latest.current = next;
    setHsv(next);
    onChange(fromHsv(next));
  };

  const area = useRef<HTMLDivElement>(null);
  const fromPointer = (e: PointerEvent) => {
    const r = area.current!.getBoundingClientRect();
    set({ ...latest.current, s: clamp((e.clientX - r.left) / r.width), v: clamp(1 - (e.clientY - r.top) / r.height) });
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const d = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] } as Record<string, [number, number]>)[e.key];
    if (!d) return;
    e.preventDefault();
    const cur = latest.current;
    set({ ...cur, s: clamp(cur.s + d[0]), v: clamp(cur.v + d[1]) });
  };

  return (
    <div className="grid gap-3">
      <div
        ref={area}
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          fromPointer(e);
        }}
        onPointerMove={(e) => e.buttons && fromPointer(e)}
        onKeyDown={onKey}
        className="relative h-36 cursor-crosshair touch-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${fromHsv({ h: hsv.h, s: 1, v: 1 })})` }}
      >
        <span aria-hidden className="absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-picker-handle shadow-[0_0_0_1px_var(--picker-halo)]"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </div>
      <Slider aria-label="Hue" min={0} max={360} step={1} value={[hsv.h]} onValueChange={([h]) => set({ ...latest.current, h: h! })}
        className="[&_[data-slot=slider-range]]:bg-transparent [&_[data-slot=slider-track]]:h-3 [&_[data-slot=slider-track]]:[background:var(--hue-spectrum)]" />
      <div className="flex items-center gap-2">
        <span aria-hidden className="size-8 shrink-0 rounded-md border" style={{ background: value }} />
        <Input aria-label="Hex" value={text} spellCheck={false} className="w-28 font-mono"
          onChange={(e) => {
            setText(e.target.value);
            const hex = normalizeHex(e.target.value);
            if (hex) onChange(hex);
          }}
          onBlur={() => setText(value)} />
      </div>
    </div>
  );
}
