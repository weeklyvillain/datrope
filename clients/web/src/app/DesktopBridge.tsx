import { useEffect, useRef } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { desktop } from "../desktop";
import { client, useApp } from "../session";
import { audioPrefs } from "../voice/audio-prefs";
import { voice } from "../voice/voice";
import { chromeStore, type ChromeState } from "./desktop-chrome";
import { readTokens } from "@/lib/theme-tokens";
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
  const mobile = useIsMobile();

  // The page draws the title bar on desktop widths; phones give it back to the shell. A reload clears the claim
  // on the shell side, so every load claims again. The page only draws its bar once the shell's first `chrome`
  // event arrives: a shell from before the claim has no such command and sends no such event, and keeps its own bar.
  const wanted = useRef(false);
  useEffect(() => {
    if (!desktop) return;
    wanted.current = !mobile;
    void desktop.claimTitleBar(!mobile).catch(() => undefined);
    if (mobile) chromeStore.setState({ claimed: false });
    // Unmounting (login, not-a-member and the like render without this bridge) gives the bar back to the shell.
    return () => {
      wanted.current = false;
      void desktop?.claimTitleBar(false).catch(() => undefined);
      chromeStore.setState({ claimed: false });
    };
  }, [mobile]);

  useEffect(
    () => desktop?.on<Omit<ChromeState, "claimed">>("chrome", (p) => chromeStore.setState({ ...p, claimed: wanted.current })),
    [],
  );

  // The app's own screens (title bar, drawer, dialogs) wear this server's colours; themes and palettes set them as
  // custom properties on the root, so resend whenever its style or class changes.
  useEffect(() => {
    if (!desktop) return;
    const d = desktop;
    const root = document.documentElement;
    let t: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const cs = getComputedStyle(root);
        d.setTheme(readTokens((n) => cs.getPropertyValue(n)));
      }, 100);
    };
    send();
    const mo = new MutationObserver(send);
    mo.observe(root, { attributes: true, attributeFilter: ["style", "class"] });
    return () => {
      clearTimeout(t);
      mo.disconnect();
    };
  }, []);

  // Empty parts of the 56 px header bands drag the window; a double-press maximizes or restores it.
  useEffect(() => {
    if (!desktop) return;
    const d = desktop;
    const INTERACTIVE = "button, a, input, textarea, select, [role=button], [role=menuitem], [role=tab], [contenteditable], [data-no-drag]";
    const inBand = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el?.closest?.("[data-titlebar-drag]") && !el.closest(INTERACTIVE) && chromeStore.getState().claimed;
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || !inBand(e.target)) return;
      if (e.detail === 2) d.windowAction("toggle_maximize");
      else if (e.detail === 1) d.startDrag();
    };
    window.addEventListener("pointerdown", down);
    return () => window.removeEventListener("pointerdown", down);
  }, []);

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
