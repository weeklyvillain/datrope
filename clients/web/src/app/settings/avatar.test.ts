import { describe, expect, it } from "vitest";
import { AVATAR, BANNER, checkAvatarFile, checkBannerFile, clampCrop, cropRect } from "./avatar";

describe("avatar file check", () => {
  it("accepts images up to 2 MB", () => {
    expect(checkAvatarFile({ type: "image/gif", size: 2 * 1024 * 1024 })).toBeNull();
    expect(checkAvatarFile({ type: "image/svg+xml", size: 10 })).toBe("Use a PNG, JPEG, WebP or GIF image");
    expect(checkAvatarFile({ type: "image/png", size: 2 * 1024 * 1024 + 1 })).toBe("Larger than 2 MB");
  });
});

describe("crop", () => {
  it("covers the circle with the short side at zoom 1", () => {
    expect(cropRect(400, 200, { zoom: 1, x: 0, y: 0 })).toEqual({ sx: 100, sy: 0, sw: 200, sh: 200 });
  });

  it("moves within the image and no further", () => {
    // At zoom 1 the 400 px side is 360 view px: 90 px of play each way.
    expect(clampCrop(400, 200, { zoom: 1, x: 500, y: 40 })).toEqual({ zoom: 1, x: 90, y: 0 });
    expect(cropRect(400, 200, { zoom: 1, x: 90, y: 0 })).toEqual({ sx: 0, sy: 0, sw: 200, sh: 200 });
  });

  it("never leaves the image through rounding", () => {
    const r = cropRect(333, 777, { zoom: 1.37, x: 1e6, y: -1e6 });
    expect(r.sx).toBeGreaterThanOrEqual(0);
    expect(r.sy).toBeGreaterThanOrEqual(0);
    expect(r.sx + r.sw).toBeLessThanOrEqual(333);
    expect(r.sy + r.sh).toBeLessThanOrEqual(777);
  });

  it("zooms between 1 and 3", () => {
    expect(cropRect(400, 200, { zoom: 2, x: 0, y: 0 })).toEqual({ sx: 150, sy: 50, sw: 100, sh: 100 });
    expect(clampCrop(400, 200, { zoom: 5, x: 0, y: 0 }).zoom).toBe(3);
    expect(clampCrop(400, 200, { zoom: 0.5, x: 0, y: 0 }).zoom).toBe(1);
  });
});

describe("banner file check", () => {
  it("accepts images up to 5 MB", () => {
    expect(checkBannerFile({ type: "image/webp", size: 5 * 1024 * 1024 })).toBeNull();
    expect(checkBannerFile({ type: "image/svg+xml", size: 10 })).toBe("Use a PNG, JPEG, WebP or GIF image");
    expect(checkBannerFile({ type: "image/png", size: 5 * 1024 * 1024 + 1 })).toBe("Larger than 5 MB");
  });
});

describe("banner crop (3:1)", () => {
  it("outputs 960 x 320", () => {
    expect(BANNER.outW / BANNER.outH).toBe(3);
    expect(AVATAR.outW).toBe(256);
  });

  it("covers the frame with the long side of a square image at zoom 1", () => {
    // 600 x 600: the frame is 300 x 100, so the width fits: a 600 x 200 slice, centred vertically.
    expect(cropRect(600, 600, { zoom: 1, x: 0, y: 0 }, BANNER)).toEqual({ sx: 0, sy: 200, sw: 600, sh: 200 });
  });

  it("covers a wide image by height", () => {
    // 1200 x 200 at zoom 1: scale = max(300/1200, 100/200) = 0.5, so the slice is 600 x 200, centred.
    expect(cropRect(1200, 200, { zoom: 1, x: 0, y: 0 }, BANNER)).toEqual({ sx: 300, sy: 0, sw: 600, sh: 200 });
  });

  it("moves within the image and no further", () => {
    expect(clampCrop(600, 600, { zoom: 1, x: 50, y: 1000 }, BANNER)).toEqual({ zoom: 1, x: 0, y: 100 });
    expect(cropRect(600, 600, { zoom: 1, x: 0, y: 100 }, BANNER)).toEqual({ sx: 0, sy: 0, sw: 600, sh: 200 });
  });

  it("zooms in on the same aspect", () => {
    expect(cropRect(600, 600, { zoom: 2, x: 0, y: 0 }, BANNER)).toEqual({ sx: 150, sy: 250, sw: 300, sh: 100 });
  });
});
