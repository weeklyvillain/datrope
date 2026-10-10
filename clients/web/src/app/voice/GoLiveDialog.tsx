import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { saveStreamPrefs, streamPrefs } from "../../voice/stream-prefs";
import { voice } from "../../voice/voice";
import { StreamFields } from "./StreamFields";

/** Picks how to stream; the browser's own picker then chooses what. */
export function GoLiveDialog({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState(() => streamPrefs.getState());
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Go Live</DialogTitle>
          <DialogDescription>Your browser asks what to share next.</DialogDescription>
        </DialogHeader>
        <StreamFields value={settings} onChange={setSettings} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => {
            saveStreamPrefs(settings);
            onClose();
            void voice.startScreen(settings); // same click, so getDisplayMedia keeps the user gesture
          }}>Go Live</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
