import type { Attachment } from "@datrope/core";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { ChevronLeft, ChevronRight, Download, Maximize, X, ZoomIn, ZoomOut } from "lucide-react";
import { client } from "../../session";
import { Button } from "@/components/ui/button";
import { useHistoryLayer } from "@/hooks/use-history-layer";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { attachmentImage } from "@/lib/sized-image";
import { pinchZoom, swipeIntent } from "@/lib/viewer-gestures";

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const STEP = 1.5;

type View = { zoom: number; x: number; y: number };
const FIT: View = { zoom: 1, x: 0, y: 0 };
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 20;

/** A full-screen gallery of a message's images. `index` is the image shown, or null when closed. */
export function ImageViewer({ images, index, onIndexChange }:
  { images: Attachment[]; index: number | null; onIndexChange: (i: number | null) => void }) {
  const [view, setView] = useState<View>(FIT);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  /** Active pointers, for pinching. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);
  /** A one-finger touch gesture at fit zoom: where it began, and whether it's still a candidate swipe/tap. */
  const touch = useRef<{ x: number; y: number; live: boolean } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const lastTouchUp = useRef(0);
  /** How far the image is dragged from the finger while swiping at fit zoom. */
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const reduceMotion = useRef(false);

  function resetGestures() {
    pointers.current.clear();
    pinch.current = null;
    drag.current = null;
    touch.current = null;
    lastTap.current = null;
    setOffset(null);
  }
  const a = index === null ? undefined : images[index];

  useHistoryLayer("viewer", index !== null, () => onIndexChange(null));
  useEffect(() => setView(FIT), [index]);
  // Drop gesture state when the viewer closes (or unmounts): a pointer still down then never delivers its up/cancel.
  useEffect(() => {
    if (index !== null) return;
    resetGestures();
  }, [index]);
  useEffect(() => resetGestures, []);

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

  function pinchState() {
    const [p, q] = [...pointers.current.values()];
    return { dist: Math.hypot(p.x - q.x, p.y - q.y), mx: (p.x + q.x) / 2, my: (p.y + q.y) / 2 };
  }

  /** Starts panning from the one remaining pointer (re-baselined so a lifted finger causes no jump). */
  function startPan(p: { x: number; y: number }) {
    drag.current = { x: p.x - viewRef.current.x, y: p.y - viewRef.current.y };
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) reduceMotion.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (pointers.current.size === 2) {
      pinch.current = { dist: pinchState().dist, zoom: viewRef.current.zoom };
      drag.current = null;
      touch.current = null;
      setOffset(null);
    } else if (pointers.current.size === 1) {
      if (viewRef.current.zoom > MIN_ZOOM) startPan({ x: e.clientX, y: e.clientY });
      if (e.pointerType === "touch") touch.current = { x: e.clientX, y: e.clientY, live: viewRef.current.zoom === MIN_ZOOM };
    }
  }

  function onPointerMove(e: PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size >= 2 && pinch.current) {
      const { dist, mx, my } = pinchState();
      const r = stage.current!.getBoundingClientRect();
      zoomTo(pinchZoom(pinch.current.zoom, pinch.current.dist, dist), mx - r.left - r.width / 2, my - r.top - r.height / 2);
      return;
    }
    const d = drag.current;
    if (d) setView((v) => ({ ...v, x: e.clientX - d.x, y: e.clientY - d.y }));
    else if (touch.current?.live && !reduceMotion.current)
      setOffset({ x: e.clientX - touch.current.x, y: Math.max(0, e.clientY - touch.current.y) });
  }

  function onPointerEnd(e: PointerEvent) {
    if (!pointers.current.delete(e.pointerId)) return;
    const cancelled = e.type === "pointercancel";
    const t = touch.current;
    if (pointers.current.size === 1) {
      // Lifted one finger of a pinch: carry on panning from the other, without a jump.
      pinch.current = null;
      touch.current = null;
      if (viewRef.current.zoom > MIN_ZOOM) startPan([...pointers.current.values()][0]);
      return;
    }
    if (pointers.current.size > 1) {
      // Still pinching with 3+ fingers: re-baseline on the remaining pair so the zoom doesn't jump.
      pinch.current = { dist: pinchState().dist, zoom: viewRef.current.zoom };
      return;
    }
    pinch.current = null;
    drag.current = null;
    touch.current = null;
    setOffset(null);
    if (e.pointerType !== "touch") return;
    lastTouchUp.current = performance.now();
    if (!t || cancelled) return;
    const dx = e.clientX - t.x, dy = e.clientY - t.y;
    if (t.live) {
      const intent = swipeIntent(dx, dy);
      if (intent === "next") return go(index! + 1);
      if (intent === "prev") return go(index! - 1);
      if (intent === "close") return onIndexChange(null);
    }
    if (Math.hypot(dx, dy) > DOUBLE_TAP_PX) { lastTap.current = null; return; }
    const prev = lastTap.current, now = performance.now();
    if (prev && now - prev.t <= DOUBLE_TAP_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) <= DOUBLE_TAP_PX) {
      lastTap.current = null;
      toggleZoom(e);
    } else lastTap.current = { t: now, x: e.clientX, y: e.clientY };
  }

  function toggleZoom(e: { clientX: number; clientY: number }) {
    if (viewRef.current.zoom > MIN_ZOOM) setView(FIT);
    else zoomTo(2.5, ...fromCentre(e));
  }

  const many = images.length > 1;
  return (
    <Dialog open={!!a} onOpenChange={(open) => { if (!open) onIndexChange(null); }}>
      <DialogContent showCloseButton={false} aria-describedby={undefined} onKeyDown={onKeyDown} onContextMenu={(e) => e.stopPropagation()}
        className="flex h-dvh max-h-none w-screen max-w-none overflow-hidden translate-x-0 translate-y-0 top-0 left-0 flex-col gap-0 rounded-none border-0 bg-background/95 p-0 pt-safe pb-safe px-safe shadow-none sm:max-w-none">
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
            onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
            onDoubleClick={(e) => { if (performance.now() - lastTouchUp.current > 500) toggleZoom(e); }}>
            {/* Keyed so the previous image never lingers while the next one loads. */}
            <img key={a.id} src={client.url(a.url)} alt={a.filename} draggable={false}
              className={cn("max-h-full max-w-full object-contain will-change-transform",
                !offset && view.zoom === MIN_ZOOM && "motion-safe:transition-transform motion-safe:duration-150")}
              style={{ transform: `translate(${view.x + (offset?.x ?? 0)}px, ${view.y + (offset?.y ?? 0)}px) scale(${view.zoom})` }} />
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
                  <img {...attachmentImage(img, 56, { cover: true })} alt="" className="size-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </>}
      </DialogContent>
    </Dialog>
  );
}
