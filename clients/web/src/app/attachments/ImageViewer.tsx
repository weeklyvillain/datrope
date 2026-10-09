import type { Attachment } from "@datrope/core";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { ChevronLeft, ChevronRight, Download, Maximize, X, ZoomIn, ZoomOut } from "lucide-react";
import { client } from "../../session";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const STEP = 1.5;

type View = { zoom: number; x: number; y: number };
const FIT: View = { zoom: 1, x: 0, y: 0 };

/** A full-screen gallery of a message's images. `index` is the image shown, or null when closed. */
export function ImageViewer({ images, index, onIndexChange }:
  { images: Attachment[]; index: number | null; onIndexChange: (i: number | null) => void }) {
  const [view, setView] = useState<View>(FIT);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const a = index === null ? undefined : images[index];

  useEffect(() => setView(FIT), [index]);

  /** Zooms to `zoom`, keeping the stage point (px, py) — relative to its centre — still. */
  function zoomTo(zoom: number, px = 0, py = 0) {
    setView((v) => {
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
      if (z === MIN_ZOOM) return FIT;
      const k = z / v.zoom;
      return { zoom: z, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  }

  /** The pointer's position relative to the stage's centre. */
  function fromCentre(e: { clientX: number; clientY: number }) {
    const r = stage.current!.getBoundingClientRect();
    return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2] as const;
  }

  function go(to: number) {
    if (to >= 0 && to < images.length) onIndexChange(to);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowLeft") go(index! - 1);
    else if (e.key === "ArrowRight") go(index! + 1);
    else if (e.key === "+" || e.key === "=") zoomTo(view.zoom * STEP);
    else if (e.key === "-") zoomTo(view.zoom / STEP);
    else if (e.key === "0") setView(FIT);
    else return;
    e.preventDefault();
  }

  function onWheel(e: WheelEvent) {
    // Proportional to the distance scrolled, so trackpads zoom smoothly and fast wheels go further.
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY; // Firefox scrolls in lines
    zoomTo(view.zoom * Math.exp(-dy * 0.002), ...fromCentre(e));
  }

  function onPointerDown(e: PointerEvent) {
    if (view.zoom === MIN_ZOOM || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX - view.x, y: e.clientY - view.y };
  }

  function onPointerMove(e: PointerEvent) {
    const d = drag.current;
    if (d) setView((v) => ({ ...v, x: e.clientX - d.x, y: e.clientY - d.y }));
  }

  const many = images.length > 1;
  return (
    <Dialog open={!!a} onOpenChange={(open) => { if (!open) onIndexChange(null); }}>
      <DialogContent showCloseButton={false} aria-describedby={undefined} onKeyDown={onKeyDown}
        className="flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 top-0 left-0 flex-col gap-0 rounded-none border-0 bg-background/95 p-0 shadow-none sm:max-w-none">
        {a && <>
          <div className="flex items-center gap-1 border-b bg-background/80 px-3 py-2">
            <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium">{a.filename}</DialogTitle>
            {many && <span className="mr-2 text-sm tabular-nums text-muted-foreground">{index! + 1} / {images.length}</span>}
            <Button variant="ghost" size="icon-sm" aria-label="Zoom out" title="Zoom out (-)"
              disabled={view.zoom <= MIN_ZOOM} onClick={() => zoomTo(view.zoom / STEP)}><ZoomOut /></Button>
            <span className="w-12 text-center text-xs tabular-nums text-muted-foreground" aria-live="polite">{Math.round(view.zoom * 100)}%</span>
            <Button variant="ghost" size="icon-sm" aria-label="Zoom in" title="Zoom in (+)"
              disabled={view.zoom >= MAX_ZOOM} onClick={() => zoomTo(view.zoom * STEP)}><ZoomIn /></Button>
            <Button variant="ghost" size="icon-sm" aria-label="Fit to screen" title="Fit to screen (0)"
              disabled={view === FIT} onClick={() => setView(FIT)}><Maximize /></Button>
            <Button asChild variant="ghost" size="icon-sm">
              <a href={client.url(a.url)} download={a.filename} aria-label="Download" title="Download"><Download /></a>
            </Button>
            <DialogClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close" title="Close (Esc)"><X /></Button>
            </DialogClose>
          </div>

          <div ref={stage} className={cn("relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden select-none",
            view.zoom > MIN_ZOOM ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in")}
            onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
            onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
            onDoubleClick={(e) => (view.zoom > MIN_ZOOM ? setView(FIT) : zoomTo(2.5, ...fromCentre(e)))}>
            {/* Keyed so the previous image never lingers while the next one loads. */}
            <img key={a.id} src={client.url(a.url)} alt={a.filename} draggable={false}
              className="max-h-full max-w-full object-contain will-change-transform"
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }} />
            {many && <>
              <Button variant="secondary" size="icon-lg" className="absolute top-1/2 left-3 -translate-y-1/2 rounded-full shadow-md"
                aria-label="Previous image" title="Previous (←)" disabled={index === 0}
                onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
                onClick={() => go(index! - 1)}><ChevronLeft /></Button>
              <Button variant="secondary" size="icon-lg" className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full shadow-md"
                aria-label="Next image" title="Next (→)" disabled={index === images.length - 1}
                onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
                onClick={() => go(index! + 1)}><ChevronRight /></Button>
            </>}
          </div>

          {many && (
            <div className="flex justify-center gap-2 overflow-x-auto border-t bg-background/80 p-2">
              {images.map((img, i) => (
                <button key={img.id} type="button" aria-label={`Show ${img.filename}`} aria-current={i === index}
                  className={cn("size-14 shrink-0 overflow-hidden rounded-md border-2 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    i === index ? "border-primary" : "border-transparent opacity-60 hover:opacity-100")}
                  onClick={() => go(i)}>
                  <img src={client.url(img.thumbnail_url || img.url)} alt="" className="size-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </>}
      </DialogContent>
    </Dialog>
  );
}
