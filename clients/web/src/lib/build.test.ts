import { describe, expect, it, vi } from "vitest";
import { isStale, reloadToNewBuild } from "./build";

describe("isStale", () => {
  it("compares real builds only", () => {
    expect(isStale("aaa", "bbb")).toBe(true);
    expect(isStale("aaa", "aaa")).toBe(false);
    expect(isStale("dev", "bbb")).toBe(false);
    expect(isStale("aaa", "dev")).toBe(false);
    expect(isStale("aaa", null)).toBe(false);
  });
});

describe("reloadToNewBuild", () => {
  it("reloads straight away without a service worker", async () => {
    const reload = vi.fn();
    await reloadToNewBuild(undefined, reload);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reloads straight away when no worker is waiting", async () => {
    const reload = vi.fn();
    const sw = { getRegistration: async () => ({ update: async () => undefined, waiting: null }) } as unknown as ServiceWorkerContainer;
    await reloadToNewBuild(sw, reload);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("waits for a worker that is still installing, then activates it", async () => {
    const reload = vi.fn();
    const worker = { state: "installing", postMessage: vi.fn(), addEventListener: (_: string, fn: () => void) => { onState = fn; } };
    let onState: (() => void) | undefined;
    let onChange: (() => void) | undefined;
    const reg = { update: async () => undefined, installing: worker as unknown, waiting: null as unknown };
    const sw = {
      getRegistration: async () => reg,
      addEventListener: (_: string, fn: () => void) => { onChange = fn; },
    } as unknown as ServiceWorkerContainer;
    const done = reloadToNewBuild(sw, reload);
    await vi.waitFor(() => expect(onState).toBeDefined());
    expect(worker.postMessage).not.toHaveBeenCalled();
    worker.state = "installed";
    reg.installing = null;
    reg.waiting = worker;
    onState?.();
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" }));
    onChange?.();
    await done;
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reloads anyway if the new worker never takes over", async () => {
    vi.useFakeTimers();
    try {
      const reload = vi.fn();
      const waiting = { postMessage: vi.fn() };
      const sw = {
        getRegistration: async () => ({ update: async () => undefined, waiting }),
        addEventListener: () => undefined,
      } as unknown as ServiceWorkerContainer;
      const done = reloadToNewBuild(sw, reload);
      await vi.advanceTimersByTimeAsync(10_000);
      await done;
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("activates a waiting worker first, then reloads once it controls the page", async () => {
    const reload = vi.fn();
    const waiting = { postMessage: vi.fn() };
    let onChange: (() => void) | undefined;
    const sw = {
      getRegistration: async () => ({ update: async () => undefined, waiting }),
      addEventListener: (_: string, fn: () => void) => { onChange = fn; },
    } as unknown as ServiceWorkerContainer;
    const done = reloadToNewBuild(sw, reload);
    await vi.waitFor(() => expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" }));
    expect(reload).not.toHaveBeenCalled();
    onChange?.();
    await done;
    expect(reload).toHaveBeenCalledOnce();
  });
});
