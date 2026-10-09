import { Server, WebSocket as MockWebSocket } from "mock-socket";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Gateway, type Frame } from "./gateway";

const URL = "ws://test.local/ws";
const ready = { session_id: "s1", user: {}, server: null, dms: [], presences: [], read_states: [] };
let server: Server | undefined;
afterEach(() => server?.stop());

/** A fake gateway server that records frames per connection. */
function fakeServer(onFrame: (f: Frame, send: (f: Frame) => void, conn: number) => void) {
  server = new Server(URL);
  const received: Frame[][] = [];
  let n = 0;
  server.on("connection", (socket) => {
    const conn = n++;
    received[conn] = [];
    const send = (f: Frame) => socket.send(JSON.stringify(f));
    socket.on("message", (data) => {
      const f = JSON.parse(String(data)) as Frame;
      received[conn].push(f);
      onFrame(f, send, conn);
    });
    send({ op: "HELLO", d: { heartbeat_interval: 60_000 } });
  });
  return { received, sockets: () => server!.clients() };
}

function gateway(overrides: Partial<ConstructorParameters<typeof Gateway>[0]> = {}) {
  return new Gateway({
    url: URL,
    WebSocket: MockWebSocket as unknown as typeof WebSocket,
    token: () => "tok",
    backoff: () => 0,
    onReady: vi.fn(),
    onDispatch: vi.fn(),
    onSessionInvalid: vi.fn(),
    ...overrides,
  });
}

describe("Gateway", () => {
  it("identifies, dispatches, and resumes after a drop", async () => {
    const fake = fakeServer((f, send) => {
      if (f.op === "IDENTIFY") {
        send({ op: "READY", d: ready });
        send({ op: "DISPATCH", t: "MESSAGE_CREATE", s: 1, d: { id: "9" } });
      }
      if (f.op === "RESUME") send({ op: "RESUMED" });
    });
    const onDispatch = vi.fn();
    const onReady = vi.fn();
    const gw = gateway({ onDispatch, onReady });
    gw.connect();

    await vi.waitFor(() => expect(onDispatch).toHaveBeenCalledWith("MESSAGE_CREATE", { id: "9" }));
    expect(onReady).toHaveBeenCalledOnce();
    expect(fake.received[0][0]).toEqual({ op: "IDENTIFY", d: { token: "tok", status: "online" } });

    fake.sockets()[0].close({ code: 4000, reason: "drop", wasClean: false });
    await vi.waitFor(() =>
      expect(fake.received[1]?.[0]).toEqual({ op: "RESUME", d: { session_id: "s1", seq: 1, token: "tok" } }));
    gw.close();
  });

  it("re-identifies after INVALID_SESSION", async () => {
    let identifies = 0;
    fakeServer((f, send) => {
      if (f.op === "IDENTIFY" && ++identifies === 1) send({ op: "INVALID_SESSION" });
      else if (f.op === "IDENTIFY") send({ op: "READY", d: ready });
    });
    const onReady = vi.fn();
    const gw = gateway({ onReady });
    gw.connect();
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    expect(identifies).toBe(2);
    gw.close();
  });

  it("stops and reports when the session is invalid (4001)", async () => {
    const fake = fakeServer(() => {});
    const onSessionInvalid = vi.fn();
    const gw = gateway({ onSessionInvalid });
    gw.connect();
    await vi.waitFor(() => expect(fake.received).toHaveLength(1));
    fake.sockets()[0].close({ code: 4001, reason: "session invalid", wasClean: true });
    await vi.waitFor(() => expect(onSessionInvalid).toHaveBeenCalledOnce());
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.received).toHaveLength(1); // no reconnect
  });
});
