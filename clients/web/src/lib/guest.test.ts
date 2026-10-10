import { describe, expect, it } from "vitest";
import { guestTtlShort, guestTtlText, timeLeft } from "./guest";

const H = 3600;
const M = 60_000;

describe("guest durations", () => {
  it("describes a link's lifetime", () => {
    expect(guestTtlText(H)).toBe("1 hour");
    expect(guestTtlText(24 * H)).toBe("24 hours");
    expect(guestTtlText(3 * 24 * H)).toBe("3 days");
    expect(guestTtlShort(6 * H)).toBe("6h");
    expect(guestTtlShort(24 * H)).toBe("24h");
    expect(guestTtlShort(30 * 24 * H)).toBe("30d");
  });
  it("counts down what is left", () => {
    expect(timeLeft((5 * 60 + 12) * M)).toBe("5h 12m");
    expect(timeLeft(51 * 60 * M)).toBe("2d 3h");
    expect(timeLeft(12 * M)).toBe("12m");
    expect(timeLeft(30_000)).toBe("less than a minute");
    expect(timeLeft(-1)).toBe("less than a minute");
  });
});
