import { useState, type FormEvent } from "react";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSubmit } from "@/hooks/use-submit";
import { client, useApp } from "../../session";

/** Starts a video for everyone in a voice channel, or changes what is on. */
export function WatchDialog({ channelId, initialUrl = "", onClose }: { channelId: string; initialUrl?: string; onClose: () => void }) {
  const name = useApp((s) => s.channels[channelId]?.name ?? "this channel");
  const [url, setUrl] = useState(initialUrl);
  const { busy, error, run } = useSubmit();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await client.startWatch(channelId, url.trim());
      onClose();
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Watch together</DialogTitle>
            <DialogDescription>
              Paste a YouTube video or a Twitch channel or VOD. Everyone in {name} watches it in sync, and anyone can pause, seek or change it.
            </DialogDescription>
          </DialogHeader>
          <Input aria-label="Video link" placeholder="https://youtu.be/…" value={url} autoFocus onChange={(e) => setUrl(e.target.value)} />
          <ErrorText error={error} />
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !url.trim()}>Start watching</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
