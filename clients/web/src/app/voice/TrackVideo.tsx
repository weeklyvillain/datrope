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
  return <video ref={ref} className={cn("size-full object-contain", mirror && "-scale-x-100")} autoPlay playsInline muted />;
}
