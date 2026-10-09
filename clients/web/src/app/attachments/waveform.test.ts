import { describe, expect, it } from "vitest";
import { peaks } from "./waveform";
import { formatDuration } from "./media";

describe("peaks", () => {
  it("takes the loudest sample of each slice across channels, scaled to 1", () => {
    const left = Float32Array.from([0.1, -0.2, 0.05, 0.1]);
    const right = Float32Array.from([0, 0, -0.4, 0]);
    expect(peaks([left, right], 2)).toEqual([0.5, 1]);
  });

  it("handles silence and empty input", () => {
    expect(peaks([new Float32Array(8)], 4)).toEqual([0, 0, 0, 0]);
    expect(peaks([], 3)).toEqual([0, 0, 0]);
  });

  it("gives every bar a sample when there are fewer samples than bars", () => {
    expect(peaks([Float32Array.from([0.5, 1])], 4)).toEqual([0.5, 0.5, 1, 1]);
  });
});

describe("formatDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(75.9)).toBe("1:15");
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDuration(NaN)).toBe("0:00");
  });
});
