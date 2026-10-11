import { useEffect } from "react";
import { desktop } from "../desktop";
import { client, useApp } from "../session";
import { audioPrefs } from "../voice/audio-prefs";
import { voice } from "../voice/voice";
import { badgeFor, desktopPtt, pttKeyFor } from "./desktop-sync";

const MAX_ICON_BYTES = 200_000;

async function iconDataUrl(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(client.url(url));
    if (!res.ok) return undefined;
    const blob = await res.blob();
    if (blob.size > MAX_ICON_BYTES || !blob.type.startsWith("image/")) return undefined;
    return await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(typeof r.result === "string" ? r.result : undefined);
      r.onerror = () => resolve(undefined);
      r.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

/** Keeps the desktop app's rail, voice handoff and global push-to-talk in step with this server. Renders nothing. */
export function DesktopBridge() {
  const name = useApp((s) => s.server?.server.name);
  const iconUrl = useApp((s) => s.server?.server.icon_url);

  useEffect(() => {
    if (!desktop || !name) return;
    let live = true;
    void (iconUrl ? iconDataUrl(iconUrl) : Promise.resolve(undefined)).then((icon) => {
      if (live) desktop?.setServerInfo(name, icon);
    });
    return () => {
      live = false;
    };
  }, [name, iconUrl]);

  useEffect(() => {
    if (!desktop) return;
    const d = desktop;
    const push = () => {
      const b = badgeFor(client.store.getState());
      d.setUnread(b.unread, b.mentions);
    };
    push();
    return client.store.subscribe(push);
  }, []);

  useEffect(() => {
    if (!desktop) return;
    const d = desktop;
    let key: string | null = null;
    const sync = () => {
      const v = voice.store.getState();
      const inCall = v.status !== "idle";
      d.setVoice(inCall);
      const p = audioPrefs.getState();
      const next = pttKeyFor(p.mode, p.pttKey.code, inCall);
      if (next === key) return;
      key = next;
      void d.setPttKey(next).then((error) => desktopPtt.setState({ error: next ? error : null }));
    };
    sync();
    const stops = [
      voice.store.subscribe(sync),
      audioPrefs.subscribe(sync),
      d.on("leave_voice", () => voice.leave()),
    ];
    return () => stops.forEach((s) => s());
  }, []);

  return null;
}
