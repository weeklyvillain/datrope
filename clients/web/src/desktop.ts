import type { StreamSettings } from "./voice/stream-prefs";

/**
 * The desktop app's bridge (clients/desktop). In a browser `desktop` is null and everything behaves as before.
 * Inside the desktop app this page runs in its own webview, and the shell shows notifications, keeps the rail's
 * badges, routes the global push-to-talk key and makes sure only one server is in a call.
 */
export interface DesktopTransport {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, cb: (payload: T) => void): Promise<() => void>;
  /** A channel to pass to a command, which then sends its messages to `cb`. */
  channel<T>(cb: (message: T) => void): Promise<unknown>;
}

export class Desktop {
  private shown = true;
  private unread?: string;
  private inCall?: boolean;
  private claimed?: boolean;
  private claim?: Promise<void>;
  private theme?: string;

  constructor(private t: DesktopTransport) {
    this.on<{ visible: boolean }>("visible", (p) => {
      this.shown = p.visible;
    });
  }

  /** Whether the rail shows this server right now (hidden servers always notify). */
  get visible(): boolean {
    return this.shown;
  }

  notify(n: { title: string; body: string; target: string }) {
    void this.t.invoke("desktop_notify", n).catch(() => undefined);
  }

  setUnread(unread: boolean, mentions: number) {
    const key = `${unread}:${mentions}`;
    if (key === this.unread) return;
    this.unread = key;
    void this.t.invoke("desktop_set_unread", { unread, mentions }).catch(() => undefined);
  }

  setVoice(inCall: boolean) {
    if (inCall === this.inCall) return;
    this.inCall = inCall;
    void this.t.invoke("desktop_voice_state", { inCall }).catch(() => undefined);
  }

  /** Registers (or with null, frees) the global push-to-talk key. Resolves to why it failed, or null. */
  async setPttKey(key: string | null): Promise<string | null> {
    try {
      await this.t.invoke("desktop_ptt_set_key", { key });
      return null;
    } catch (e) {
      return typeof e === "string" ? e : "This key can't be used outside Datrope.";
    }
  }

  /**
   * Asks the shell to hide its bar above this page: the page's own top bars carry the window buttons. Resolves once
   * the shell answered; a shell without the command rejects, and the next call with the same value tries again.
   */
  claimTitleBar(claimed: boolean): Promise<void> {
    if (claimed === this.claimed && this.claim) return this.claim;
    this.claimed = claimed;
    const claim: Promise<void> = this.t.invoke<void>("desktop_title_bar", { claimed }).catch((e: unknown) => {
      if (this.claim === claim) {
        this.claimed = undefined;
        this.claim = undefined;
      }
      throw e;
    });
    this.claim = claim;
    return claim;
  }

  windowAction(action: "minimize" | "toggle_maximize" | "close" | "servers" | "update") {
    void this.t.invoke("desktop_window", { action }).catch(() => undefined);
  }

  /** Sends the colour tokens for the app's own screens (title bar, drawer, dialogs), when they changed. */
  setTheme(tokens: Record<string, string>) {
    const key = JSON.stringify(tokens);
    if (key === this.theme) return;
    this.theme = key;
    void this.t.invoke("desktop_set_theme", { tokens }).catch(() => undefined);
  }

  startDrag() {
    void this.t.invoke("desktop_start_drag").catch(() => undefined);
  }

  /** Opens a link in the system browser. */
  openUrl(url: string) {
    void this.t.invoke("desktop_open_url", { url }).catch(() => undefined);
  }

  setServerInfo(name: string, icon?: string) {
    void this.t.invoke("desktop_server_info", { name, icon: icon ?? null }).catch(() => undefined);
  }

  /**
   * Opens the app's screen picker and, once the user picks, starts capturing at up to `fps`. With `settings` the
   * picker also offers the stream quality, starting from these, and the capture runs at the fps chosen there.
   * Resolves to the capture's generation (frame messages and the shared buffer carry it) and the chosen settings,
   * or null if the user cancelled.
   */
  async pickScreen<T>(
    fps: number, onFrame: (message: T) => void, settings?: StreamSettings,
  ): Promise<{ gen: number; settings?: StreamSettings } | null> {
    const frames = await this.t.channel(onFrame);
    const picked = await this.t.invoke<number | { gen: number; settings: StreamSettings } | null>(
      "desktop_screen_pick", { fps, frames, settings: settings ?? null },
    );
    // A shell from before the picker offered quality answers with just the generation.
    return typeof picked === "number" ? { gen: picked } : picked;
  }

  stopScreen() {
    void this.t.invoke("desktop_screen_stop").catch(() => undefined);
  }

  on<T>(event: "ptt" | "leave_voice" | "open_notification" | "visible" | "chrome", cb: (payload: T) => void): () => void {
    let stop: (() => void) | undefined;
    let stopped = false;
    void this.t.listen<T>(event, cb).then((un) => {
      if (stopped) un();
      else stop = un;
    }).catch(() => undefined);
    return () => {
      stopped = true;
      stop?.();
    };
  }
}

/**
 * Which URL a click on `link` should open in the system browser, or null to let the page handle it: links to other
 * sites, new-tab links (downloads included) and middle clicks. The webview itself only shows this server's app.
 */
export function linkToOpen(link: { href: string; target: string }, pageOrigin: string, button: number): string | null {
  if (button !== 0 && button !== 1) return null;
  let url: URL;
  try {
    url = new URL(link.href, pageOrigin);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return null;
  const external = url.origin !== pageOrigin;
  return external || link.target === "_blank" || button === 1 ? url.href : null;
}

/**
 * Routes the shell's `{ event, payload }` messages to the callbacks registered for each event. The shell sends
 * everything for this page over one channel (pages get no event permissions, so servers can't reach each other).
 */
export function eventDispatcher() {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    add(event: string, cb: (payload: unknown) => void): () => void {
      const set = handlers.get(event) ?? new Set();
      handlers.set(event, set);
      set.add(cb);
      return () => set.delete(cb);
    },
    dispatch(message: unknown) {
      if (typeof message !== "object" || message === null) return;
      const { event, payload } = message as { event?: unknown; payload?: unknown };
      if (typeof event !== "string") return;
      for (const cb of handlers.get(event) ?? []) cb(payload);
    },
  };
}

/** Loads @tauri-apps/api only inside the desktop app, so the browser bundle never pays for it. */
function tauriTransport(): DesktopTransport {
  const events = eventDispatcher();
  let subscribed: Promise<void> | undefined;
  return {
    invoke: (cmd, args) => import("@tauri-apps/api/core").then((m) => m.invoke(cmd, args)),
    listen: (event, cb) => {
      const stop = events.add(event, cb as (payload: unknown) => void);
      subscribed ??= import("@tauri-apps/api/core").then((m) =>
        m.invoke<void>("desktop_subscribe", { channel: new m.Channel<unknown>(events.dispatch) }),
      );
      return subscribed.then(() => stop);
    },
    channel: (cb) => import("@tauri-apps/api/core").then((m) => new m.Channel(cb)),
  };
}

export const desktop: Desktop | null =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? new Desktop(tauriTransport()) : null;
