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

  setServerInfo(name: string, icon?: string) {
    void this.t.invoke("desktop_server_info", { name, icon: icon ?? null }).catch(() => undefined);
  }

  /**
   * Opens the app's screen picker and, once the user picks, starts capturing at up to `fps`. Resolves to the
   * capture's generation (frame messages and the shared buffer carry it), or null if the user cancelled.
   */
  async pickScreen<T>(fps: number, onFrame: (message: T) => void): Promise<number | null> {
    const frames = await this.t.channel(onFrame);
    return this.t.invoke<number | null>("desktop_screen_pick", { fps, frames });
  }

  stopScreen() {
    void this.t.invoke("desktop_screen_stop").catch(() => undefined);
  }

  on<T>(event: "ptt" | "leave_voice" | "open_notification" | "visible", cb: (payload: T) => void): () => void {
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
