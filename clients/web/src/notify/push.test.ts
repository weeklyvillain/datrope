import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  GET: vi.fn(async () => ({ data: { public_key: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U" }, response: new Response(null, { status: 200 }) })),
  PUT: vi.fn(async () => ({ response: new Response(null, { status: 204 }) })),
  DELETE: vi.fn(async () => ({ response: new Response(null, { status: 204 }) })),
}));
vi.mock("../session", () => ({ client: { api } }));
vi.mock("../desktop", () => ({ desktop: null }));

import { disablePush, needsHomeScreen, syncPush } from "./push";

function fakeSub(endpoint = "https://push.example/1") {
  return {
    endpoint,
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
  };
}

let current: ReturnType<typeof fakeSub> | null;
const pushManager = {
  getSubscription: vi.fn(async () => current),
  subscribe: vi.fn(async () => (current = fakeSub())),
};

// The suite runs in Node (no DOM): let `window` be the global object.
vi.stubGlobal("window", globalThis);

beforeEach(() => {
  vi.clearAllMocks();
  current = null;
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: vi.fn(async () => ({ pushManager })) } });
  Object.defineProperty(window, "PushManager", { configurable: true, value: function PushManager() {} });
});

describe("syncPush", () => {
  it("subscribes and saves the level when enabled", async () => {
    await syncPush({ enabled: true, level: "mentions" }, "granted");
    expect(pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(api.PUT).toHaveBeenCalledWith("/api/push/subscription", {
      body: { endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" }, level: "mentions" },
    });
  });

  it("reuses an existing subscription and re-saves it (startup resync, level change)", async () => {
    current = fakeSub("https://push.example/old");
    await syncPush({ enabled: true, level: "all" }, "granted");
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(api.PUT).toHaveBeenCalledWith("/api/push/subscription", expect.objectContaining({
      body: expect.objectContaining({ endpoint: "https://push.example/old", level: "all" }),
    }));
  });

  it("unsubscribes when disabled or not permitted", async () => {
    current = fakeSub();
    const sub = current;
    await syncPush({ enabled: false, level: "all" }, "granted");
    expect(api.DELETE).toHaveBeenCalledWith("/api/push/subscription", { body: { endpoint: "https://push.example/1" } });
    expect(sub.unsubscribe).toHaveBeenCalled();

    current = fakeSub();
    await syncPush({ enabled: true, level: "all" }, "denied");
    expect(current.unsubscribe).toHaveBeenCalled();
  });

  it("does nothing without push support", async () => {
    // @ts-expect-error test removes the API
    delete window.PushManager;
    await syncPush({ enabled: true, level: "all" }, "granted");
    expect(api.PUT).not.toHaveBeenCalled();
  });
});

describe("without a service worker registration", () => {
  it("disablePush and syncPush resolve and call nothing", async () => {
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: vi.fn(async () => undefined) } });
    await disablePush();
    await syncPush({ enabled: true, level: "all" }, "granted");
    expect(api.GET).not.toHaveBeenCalled();
    expect(api.PUT).not.toHaveBeenCalled();
    expect(api.DELETE).not.toHaveBeenCalled();
  });
});

describe("disablePush", () => {
  it("is a no-op with no subscription", async () => {
    await disablePush();
    expect(api.DELETE).not.toHaveBeenCalled();
  });
});

describe("needsHomeScreen", () => {
  it("is true on iPhone Safari outside the installed app", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1");
    Object.defineProperty(navigator, "standalone", { configurable: true, value: false });
    expect(needsHomeScreen()).toBe(true);
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
    expect(needsHomeScreen()).toBe(false);
  });

  it("is false elsewhere", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Linux; Android 14) Chrome/129 Mobile");
    expect(needsHomeScreen()).toBe(false);
  });
});
