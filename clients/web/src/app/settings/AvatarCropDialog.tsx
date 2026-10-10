import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorText } from "@/components/error-text";
import { useSubmit } from "@/hooks/use-submit";
import { cn } from "@/lib/utils";
import { client } from "../../session";
import { AVATAR, BANNER, clampCrop, cropScale, cropToBlob, gifCrop, type Crop } from "./avatar";

const STEP = 4;

/** Moves and zooms a chosen image under a circle (avatar, 256 px) or a 3:1 strip (banner, 960 × 320); Apply uploads the crop. */
export function AvatarCropDialog({ file, kind = "avatar", onClose, onDone }: { file: File; kind?: "avatar" | "banner"; onClose: () => void; onDone: () => void }) {
  const spec = kind === "banner" ? BANNER : AVATAR;
  const [url, setUrl] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  const imgRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number }>();
  const [size, setSize] = useState<{ w: number; h: number }>();
  const [crop, setCrop] = useState<Crop>({ zoom: 1, x: 0, y: 0 });
  const { busy, error, run } = useSubmit();

  const update = (c: Crop) => size && setCrop(clampCrop(size.w, size.h, c, spec));
  const scale = size ? cropScale(size.w, size.h, crop.zoom, spec) : 1;

  const apply = () => run(async () => {
    const img = imgRef.current;
    if (!img || !size) throw new Error("The image has not loaded.");
    const upload = (kind === "banner" ? client.uploadBanner : client.uploadAvatar).bind(client);
    // A GIF goes up whole with its crop, so the server can crop every frame and keep it animated.
    if (file.type === "image/gif") await upload(file, gifCrop(size.w, size.h, crop, spec));
    else await upload(await cropToBlob(img, crop, spec));
    onDone();
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className={kind === "banner" ? "sm:max-w-[420px]" : "sm:max-w-[360px]"}>
        <DialogHeader>
          <DialogTitle>{kind === "banner" ? "Crop your banner" : "Crop your avatar"}</DialogTitle>
          <DialogDescription>Drag the image to move it.</DialogDescription>
        </DialogHeader>
        <div tabIndex={0} aria-label={kind === "banner" ? "Banner position" : "Avatar position"}
          className="relative mx-auto touch-none cursor-grab select-none overflow-hidden rounded-md bg-muted outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          style={{ width: spec.viewW, height: spec.viewH }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { px: e.clientX, py: e.clientY, x: crop.x, y: crop.y };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d) update({ ...crop, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py });
          }}
          onPointerUp={() => { drag.current = undefined; }}
          onPointerCancel={() => { drag.current = undefined; }}
          onKeyDown={(e) => {
            const move = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] }[e.key];
            if (!move) return;
            e.preventDefault();
            update({ ...crop, x: crop.x + move[0], y: crop.y + move[1] });
          }}>
          {url && <img ref={imgRef} src={url} alt="" draggable={false}
            onError={() => setLoadError("This image could not be read.")}
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            className="pointer-events-none absolute max-w-none"
            style={size ? {
              width: size.w * scale,
              height: size.h * scale,
              left: spec.viewW / 2 + crop.x - (size.w * scale) / 2,
              top: spec.viewH / 2 + crop.y - (size.h * scale) / 2,
            } : { visibility: "hidden" }} />}
          <div aria-hidden
            className={cn("pointer-events-none absolute ring-2 ring-foreground shadow-[0_0_0_999px_color-mix(in_srgb,var(--background)_60%,transparent)]", kind === "banner" ? "rounded-sm" : "rounded-full")}
            style={{ width: spec.frameW, height: spec.frameH, left: (spec.viewW - spec.frameW) / 2, top: (spec.viewH - spec.frameH) / 2 }} />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Zoom</span>
          <input type="range" min={1} max={3} step={0.01} value={crop.zoom} aria-label="Zoom"
            onChange={(e) => update({ ...crop, zoom: Number(e.target.value) })}
            className={cn(
              "h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary",
              "[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary",
              "[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary",
            )} />
        </div>
        <ErrorText error={loadError ?? error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void apply()} disabled={busy || !size}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
