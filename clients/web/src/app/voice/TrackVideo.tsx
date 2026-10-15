import type { LocalVideoTrack, RemoteVideoTrack } from "livekit-client";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/** Plays a LiveKit video track. Your own camera is mirrored, like a mirror. */
export function TrackVideo({ track, mirror }: { track: LocalVideoTrack | RemoteVideoTrack; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  // Out of the tile's grid flow: an auto grid row would otherwise size to the video's own height and crop it.
  return <video ref={ref} className={cn("absolute inset-0 size-full object-contain", mirror && "-scale-x-100")} autoPlay playsInline muted />;
}
