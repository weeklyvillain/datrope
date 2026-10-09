import { describe, expect, it } from "vitest";
import { checkAvatarFile, clampCrop, cropRect } from "./avatar";

describe("avatar file check", () => {
  it("accepts images up to 2 MB", () => {
    expect(checkAvatarFile({ type: "image/gif", size: 2 * 1024 * 1024 })).toBeNull();
    expect(checkAvatarFile({ type: "image/svg+xml", size: 10 })).toBe("Use a PNG, JPEG, WebP or GIF image");
    expect(checkAvatarFile({ type: "image/png", size: 2 * 1024 * 1024 + 1 })).toBe("Larger than 2 MB");
  });
});

describe("crop", () => {
  it("covers the circle with the short side at zoom 1", () => {
    expect(cropRect(400, 200, { zoom: 1, x: 0, y: 0 })).toEqual({ sx: 100, sy: 0, size: 200 });
  });

  it("moves within the image and no further", () => {
    // At zoom 1 the 400 px side is 360 view px: 90 px of play each way.
    expect(clampCrop(400, 200, { zoom: 1, x: 500, y: 40 })).toEqual({ zoom: 1, x: 90, y: 0 });
    expect(cropRect(400, 200, { zoom: 1, x: 90, y: 0 })).toEqual({ sx: 0, sy: 0, size: 200 });
  });

  it("zooms between 1 and 3", () => {
    expect(cropRect(400, 200, { zoom: 2, x: 0, y: 0 })).toEqual({ sx: 150, sy: 50, size: 100 });
    expect(clampCrop(400, 200, { zoom: 5, x: 0, y: 0 }).zoom).toBe(3);
    expect(clampCrop(400, 200, { zoom: 0.5, x: 0, y: 0 }).zoom).toBe(1);
  });
});
