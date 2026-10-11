import { describe, expect, it, vi } from "vitest";
import { Desktop, eventDispatcher, type DesktopTransport } from "./desktop";

function fake() {
  const calls: [string, Record<string, unknown> | undefined][] = [];
  const handlers = new Map<string, (p: unknown) => void>();
  let fail: string | undefined;
  const t: DesktopTransport = {
    invoke: async <T,>(cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      if (fail) throw fail;
      return undefined as T;
    },
    listen: async <T,>(event: string, cb: (p: T) => void) => {
      handlers.set(event, cb as (p: unknown) => void);
      return () => handlers.delete(event);
    },
  };
  return { t, calls, handlers, failWith: (e: string | undefined) => (fail = e) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Desktop", () => {
  it("sends notifications through the shell", async () => {
    const f = fake();
    new Desktop(f.t).notify({ title: "Alice in #general", body: "hi", target: "42" });
    await tick();
    expect(f.calls).toContainEqual(["desktop_notify", { title: "Alice in #general", body: "hi", target: "42" }]);
  });

  it("only sends unread and voice state when they change", async () => {
    const f = fake();
    const d = new Desktop(f.t);
    d.setUnread(true, 2);
    d.setUnread(true, 2);
    d.setUnread(false, 0);
    d.setVoice(true);
    d.setVoice(true);
    await tick();
    expect(f.calls.filter(([c]) => c === "desktop_set_unread")).toHaveLength(2);
    expect(f.calls.filter(([c]) => c === "desktop_voice_state")).toEqual([["desktop_voice_state", { inCall: true }]]);
  });

  it("tracks whether its webview is the visible one", async () => {
    const f = fake();
    const d = new Desktop(f.t);
    await tick();
    expect(d.visible).toBe(true);
    f.handlers.get("visible")!({ visible: false });
    expect(d.visible).toBe(false);
  });

  it("reports why a push-to-talk key can't be global", async () => {
    const f = fake();
    const d = new Desktop(f.t);
    expect(await d.setPttKey("F8")).toBeNull();
    f.failWith("HotKey already registered");
    expect(await d.setPttKey("F9")).toBe("HotKey already registered");
    expect(f.calls).toContainEqual(["desktop_ptt_set_key", { key: "F9" }]);
  });

  it("stops listening even if unsubscribed before listen resolves", async () => {
    const f = fake();
    const d = new Desktop(f.t);
    const cb = vi.fn();
    const stop = d.on("ptt", cb);
    stop();
    await tick();
    expect(f.handlers.has("ptt")).toBe(false);
  });
});

describe("eventDispatcher", () => {
  it("routes channel messages to the callbacks for their event", () => {
    const d = eventDispatcher();
    const ptt = vi.fn();
    const ptt2 = vi.fn();
    const visible = vi.fn();
    d.add("ptt", ptt);
    d.add("ptt", ptt2);
    d.add("visible", visible);
    d.dispatch({ event: "ptt", payload: { down: true } });
    expect(ptt).toHaveBeenCalledWith({ down: true });
    expect(ptt2).toHaveBeenCalledWith({ down: true });
    expect(visible).not.toHaveBeenCalled();
  });

  it("stops calling a callback once removed", () => {
    const d = eventDispatcher();
    const cb = vi.fn();
    const stop = d.add("leave_voice", cb);
    stop();
    d.dispatch({ event: "leave_voice", payload: null });
    expect(cb).not.toHaveBeenCalled();
  });

  it("ignores malformed messages and events nobody listens to", () => {
    const d = eventDispatcher();
    const cb = vi.fn();
    d.add("visible", cb);
    for (const m of [null, "visible", 1, {}, { event: 2 }, { event: "open_notification", payload: {} }]) d.dispatch(m);
    expect(cb).not.toHaveBeenCalled();
  });
});
