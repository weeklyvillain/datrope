import { describe, expect, it, vi } from "vitest";

vi.mock("./gate-worklet?worker&url", () => ({ default: "gate-worklet.js" }));
vi.mock("./rnnoise", () => ({ createRnnoise: vi.fn() }));

const { MicChain, MicProcessor } = await import("./mic-processor");

describe("mic processor", () => {
  it("closes a chain that finishes starting after the processor was destroyed", async () => {
    let resolve!: (c: unknown) => void;
    const chain = { output: {}, setPtt: vi.fn(), close: vi.fn(async () => undefined) };
    vi.spyOn(MicChain, "create").mockReturnValue(new Promise((r) => (resolve = r)) as never);
    const p = new MicProcessor({ mode: "vad", auto: true, thresholdDb: -50, enhanced: false });
    const init = p.init({ track: {} } as never);
    await p.destroy(); // left the call while the worklet was still loading
    resolve(chain);
    await expect(init).rejects.toThrow();
    expect(chain.close).toHaveBeenCalled();
    expect(p.processedTrack).toBeUndefined();
  });
});
