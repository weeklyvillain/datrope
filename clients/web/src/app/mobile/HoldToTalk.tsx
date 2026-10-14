import { Mic } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useAudioPrefs } from "../../voice/audio-prefs";
import { setPttFromUi } from "../../voice/ptt";
import { BareButton } from "@/components/bare-button";

/** Push to talk on a touch screen: talk while the button is held. Shown only in push-to-talk mode. */
export function HoldToTalk({ small = false, className }: { small?: boolean; className?: string }) {
  const ptt = useAudioPrefs((p) => p.mode === "ptt");
  const [held, setHeld] = useState(false);
  const down = useRef(false);
  const set = (d: boolean) => {
    if (d === down.current) return;
    down.current = d;
    setHeld(d);
    setPttFromUi(d);
  };
  // `set` only touches refs and stable setters, so effects may keep the first render's copy.
  // Unmounted while held (the bar collapsed): let go, so the mic can't stay open.
  useEffect(() => () => { if (down.current) setPttFromUi(false); }, []);
  // Push to talk turned off while held: the button disappears but stays mounted, so no pointerup comes. Let go.
  useEffect(() => { if (!ptt) set(false); }, [ptt]);
  // The app going to the background (screen locked, app switched) while held: let go too.
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === "hidden") set(false); };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);
  if (!ptt) return null;
  return (
    <BareButton aria-label="Hold to talk" aria-pressed={held}
      className={cn("grid flex-none touch-none place-items-center rounded-full border select-none [-webkit-touch-callout:none]",
        held ? "border-online bg-online text-background" : "bg-muted text-foreground",
        small ? "size-[44px]" : "size-[64px]", className)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        set(true);
      }}
      onPointerUp={() => set(false)} onPointerCancel={() => set(false)} onLostPointerCapture={() => set(false)}
      onContextMenu={(e) => e.preventDefault()}
      // Keyboard: Space or Enter held down talks too.
      onKeyDown={(e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); set(true); } }}
      onKeyUp={(e) => { if (e.key === " " || e.key === "Enter") set(false); }}
      onBlur={() => set(false)}>
      <Mic className={small ? "size-5" : "size-7"} />
    </BareButton>
  );
}
