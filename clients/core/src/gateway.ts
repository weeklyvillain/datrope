import type { PresenceStatus, Ready } from "./types";

export interface Frame {
  op: string;
  d?: unknown;
  s?: number;
  t?: string;
}

export type ConnectionStatus = "connecting" | "ready" | "reconnecting" | "closed";

const CLOSE_SESSION_INVALID = 4001;
const CLOSE_RATE_LIMITED = 4008;

export interface GatewayOptions {
  url: string;
  token?: () => string | undefined;
  status?: PresenceStatus;
  WebSocket?: typeof WebSocket;
  backoff?: (attempt: number) => number;
  onReady: (ready: Ready) => void;
  onDispatch: (type: string, data: unknown) => void;
  onStatus?: (status: ConnectionStatus) => void;
  /** The session was revoked or expired: sign in again. */
  onSessionInvalid: () => void;
}

/** Exponential backoff with jitter: ~1s, 2s, 4s … capped at 30s. */
export function backoff(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

export class Gateway {
  private ws?: WebSocket;
  private sessionId?: string;
  private seq = 0;
  private attempts = 0;
  private stopped = true;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private status: PresenceStatus;

  constructor(private readonly o: GatewayOptions) {
    this.status = o.status ?? "online";
  }

  connect() {
    this.stopped = false;
    this.open();
  }

  close() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.ws?.close(1000);
    this.ws = undefined;
    this.o.onStatus?.("closed");
  }

  setPresence(status: PresenceStatus) {
    this.status = status;
    this.send({ op: "PRESENCE_SET", d: { status } });
  }

  private open() {
    const WS = this.o.WebSocket ?? WebSocket;
    this.o.onStatus?.(this.attempts === 0 && !this.sessionId ? "connecting" : "reconnecting");
    const ws = new WS(this.o.url);
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.onFrame(JSON.parse(String(ev.data)) as Frame);
    };
    ws.onclose = (ev) => {
      if (this.ws === ws) this.onClose(ev.code);
    };
  }

  private send(f: Frame) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(f));
  }

  private onFrame(f: Frame) {
    switch (f.op) {
      case "HELLO":
        this.startHeartbeat((f.d as { heartbeat_interval: number }).heartbeat_interval);
        if (this.sessionId) this.send({ op: "RESUME", d: { session_id: this.sessionId, seq: this.seq, token: this.o.token?.() } });
        else this.identify();
        break;
      case "READY": {
        const ready = f.d as Ready;
        this.sessionId = ready.session_id;
        this.seq = 0;
        this.attempts = 0;
        this.o.onStatus?.("ready");
        this.o.onReady(ready);
        break;
      }
      case "RESUMED":
        this.attempts = 0;
        this.o.onStatus?.("ready");
        break;
      case "INVALID_SESSION":
        this.sessionId = undefined;
        this.seq = 0;
        this.identify();
        break;
      case "DISPATCH":
        if (f.s) this.seq = f.s;
        this.o.onDispatch(f.t ?? "", f.d);
        break;
    }
  }

  private identify() {
    this.send({ op: "IDENTIFY", d: { token: this.o.token?.(), status: this.status } });
  }

  private startHeartbeat(interval: number) {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => this.send({ op: "HEARTBEAT" }), interval);
  }

  private stopHeartbeat() {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private onClose(code: number) {
    this.stopHeartbeat();
    this.ws = undefined;
    if (this.stopped) return;
    if (code === CLOSE_SESSION_INVALID) {
      this.stopped = true;
      this.sessionId = undefined;
      this.o.onStatus?.("closed");
      this.o.onSessionInvalid();
      return;
    }
    const delay = code === CLOSE_RATE_LIMITED ? 60_000 : (this.o.backoff ?? backoff)(this.attempts++);
    this.o.onStatus?.("reconnecting");
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }
}
