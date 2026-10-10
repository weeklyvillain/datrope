import { describe, expect, it } from "vitest";
import { rate, readSample, type Stat } from "./stats";

const pair: Stat = { type: "candidate-pair", id: "cp", nominated: true, state: "succeeded", currentRoundTripTime: 0.042 };

describe("readSample", () => {
  it("reads RTT, loss and jitter while publishing", () => {
    const remote: Stat = { type: "remote-inbound-rtp", id: "r", kind: "audio", fractionLost: 0.02, jitter: 0.004, roundTripTime: 0.05 };
    const stale: Stat = { type: "candidate-pair", id: "old", state: "failed", currentRoundTripTime: 9 };
    const { sample } = readSample([stale, pair, remote], new Map());
    expect(sample.rttMs).toBeCloseTo(42);
    expect(sample.lossPct).toBeCloseTo(2);
    expect(sample.jitterMs).toBeCloseTo(4);
  });

  it("falls back to the RTCP round trip without a candidate pair", () => {
    const { sample } = readSample([{ type: "remote-inbound-rtp", id: "r", kind: "audio", roundTripTime: 0.08 }], new Map());
    expect(sample.rttMs).toBeCloseTo(80);
  });

  it("computes loss from received audio between polls when not publishing", () => {
    const first = readSample([pair, { type: "inbound-rtp", id: "a", kind: "audio", packetsLost: 10, packetsReceived: 1000, jitter: 0.01 }], new Map());
    expect(first.sample.lossPct).toBeUndefined(); // no previous poll to compare with
    expect(first.sample.jitterMs).toBeCloseTo(10);
    const second = readSample([pair, { type: "inbound-rtp", id: "a", kind: "audio", packetsLost: 13, packetsReceived: 1097, jitter: 0.02 }], first.counters);
    expect(second.sample.lossPct).toBeCloseTo(3);
  });

  it("ignores video and returns nothing for an empty report", () => {
    expect(readSample([{ type: "inbound-rtp", id: "v", kind: "video", packetsLost: 5, packetsReceived: 5, jitter: 1 }], new Map()).sample).toEqual({});
    expect(readSample([], new Map()).sample).toEqual({});
  });
});

describe("rate", () => {
  it("is unknown without samples", () => {
    expect(rate([])).toEqual({ rating: "unknown" });
    expect(rate([{}, {}])).toEqual({ rating: "unknown" });
  });

  it("rates by the worst metric", () => {
    expect(rate([{ rttMs: 40, lossPct: 0, jitterMs: 5 }]).rating).toBe("good");
    expect(rate([{ rttMs: 40, lossPct: 2, jitterMs: 5 }]).rating).toBe("ok");
    expect(rate([{ rttMs: 300, lossPct: 0, jitterMs: 5 }]).rating).toBe("poor");
    expect(rate([{ rttMs: 99.9 }]).rating).toBe("good");
    expect(rate([{ rttMs: 100 }]).rating).toBe("ok");
    expect(rate([{ jitterMs: 50 }]).rating).toBe("poor");
  });

  it("averages the last three samples", () => {
    const q = rate([{ rttMs: 1000 }, { rttMs: 50 }, { rttMs: 60 }, { rttMs: 70 }]);
    expect(q.rttMs).toBeCloseTo(60);
    expect(q.rating).toBe("good");
    expect(rate([{ rttMs: 50 }, { rttMs: 50 }, { rttMs: 400 }]).rating).toBe("ok"); // one spike: average 166
  });
});
