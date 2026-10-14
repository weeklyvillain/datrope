import { describe, expect, it } from "vitest";
import { videoControlsAfterTap } from "./video-controls";

describe("tap on a video (touch)", () => {
  it("shows hidden controls instead of pausing", () =>
    expect(videoControlsAfterTap({ playing: true, shown: false })).toEqual({ shown: true, toggle: false }));
  it("toggles playback when controls are already shown", () =>
    expect(videoControlsAfterTap({ playing: true, shown: true })).toEqual({ shown: true, toggle: true }));
  it("plays a paused video", () =>
    expect(videoControlsAfterTap({ playing: false, shown: true })).toEqual({ shown: true, toggle: true }));
});
