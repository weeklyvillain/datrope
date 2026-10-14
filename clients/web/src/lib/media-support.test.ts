import { describe, expect, it } from "vitest";
import { canFullscreen, canShareScreen } from "./media-support";

describe("media support", () => {
  it("screen share needs getDisplayMedia", () => {
    expect(canShareScreen({ mediaDevices: { getDisplayMedia: () => undefined } } as unknown as Navigator)).toBe(true);
    expect(canShareScreen({ mediaDevices: {} } as unknown as Navigator)).toBe(false);
    expect(canShareScreen(undefined)).toBe(false);
  });
  it("fullscreen needs fullscreenEnabled", () => {
    expect(canFullscreen({ fullscreenEnabled: true } as Document)).toBe(true);
    expect(canFullscreen({ fullscreenEnabled: false } as Document)).toBe(false);
  });
});
