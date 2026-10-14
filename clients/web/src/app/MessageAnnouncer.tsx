import { useEffect, useRef, useState } from "react";
import { useWindowFocus } from "@/hooks/use-window-focus";
import { announceStep, announcement, plainPreview, type AnnounceState } from "@/lib/announce";
import { displayName, useApp } from "../session";

/** Speaks new messages from others in the channel on screen, one short line per burst (≤ 1 s). */
export function MessageAnnouncer({ channelId }: { channelId: string }) {
  const list = useApp((s) => s.messages[channelId]);
  const meId = useApp((s) => s.me?.id);
  const focused = useWindowFocus();
  const [text, setText] = useState("");
  const mark = useRef<AnnounceState | undefined>(undefined);
  const batch = useRef<{ author: string; text: string }[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const frame = useRef<number>();

  useEffect(() => {
    clearTimeout(timer.current);
    batch.current = [];
    mark.current = undefined;
    setText("");
  }, [channelId]);
  useEffect(() => {
    if (!list) return;
    const r = announceStep(list, mark.current, meId);
    mark.current = r.state;
    if (!focused || r.fresh.length === 0) return;
    batch.current.push(...r.fresh.map((m) => ({ author: displayName(m.author!), text: plainPreview(m.content) })));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const line = announcement(batch.current);
      batch.current = [];
      setText("");
      cancelAnimationFrame(frame.current ?? 0);
      frame.current = requestAnimationFrame(() => setText(line));
    }, 1000);
  }, [channelId, list, meId, focused]);
  useEffect(() => () => { clearTimeout(timer.current); cancelAnimationFrame(frame.current ?? 0); }, []);
  return <div role="status" aria-live="polite" className="sr-only">{text}</div>;
}
