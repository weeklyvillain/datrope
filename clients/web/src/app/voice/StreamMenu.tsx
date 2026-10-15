import { MonitorUp, ScreenShareOff } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { saveStreamPrefs, type StreamSettings } from "../../voice/stream-prefs";
import { useVoice, voice } from "../../voice/voice";
import { StreamFields } from "./StreamFields";

/** While live: change what and how I share, or stop. Changes apply at once. */
export function StreamMenuContent({ onDone }: { onDone: () => void }) {
  const stream = useVoice((v) => v.stream);
  // Between the video going out and the settings landing (a moment while going live).
  if (!stream) return <p className="text-sm text-muted-foreground" role="status">Starting your stream…</p>;
  return (
    <div className="grid gap-3" role="group" aria-label="Stream settings">
      <Button variant="outline" onClick={() => void voice.changeSource()}><MonitorUp /> Change source</Button>
      <Separator />
      <StreamFields value={stream} onChange={(s) => {
        // Only what changed: a click made before the last change landed must not undo it.
        const patch = Object.fromEntries(Object.entries(s).filter(([k, v]) => stream[k as keyof StreamSettings] !== v));
        void voice.applyStream(patch).then(() => {
          // What is actually sent becomes the next Go Live default (not a refused or cancelled change).
          const sent = voice.store.getState().stream;
          if (sent) saveStreamPrefs(sent);
        });
      }} />
      <Separator />
      <Button variant="destructive" onClick={() => {
        onDone();
        void voice.stopScreen();
      }}><ScreenShareOff /> Stop streaming</Button>
    </div>
  );
}
