import { describe, expect, it, vi } from "vitest";

vi.mock("@/session", () => ({ client: { url: (p: string) => `https://chat.test${p}` } }));

import { attachmentImage, sizedImage } from "./sized-image";

describe("sizedImage", () => {
  it("asks for the 1x and 2x buckets", () => {
    expect(sizedImage("/api/avatars/1", 40)).toEqual({
      src: "https://chat.test/api/avatars/1?w=64",
      srcSet: "https://chat.test/api/avatars/1?w=64 1x, https://chat.test/api/avatars/1?w=128 2x",
    });
  });

  it("appends to an existing query", () => {
    expect(sizedImage("/api/avatars/1?v=abc", 32).src).toBe("https://chat.test/api/avatars/1?v=abc&w=32");
  });

  it("drops the 2x candidate when both hit the largest bucket", () => {
    expect(sizedImage("/api/server/banner", 2000)).toEqual({ src: "https://chat.test/api/server/banner?w=1600" });
  });

  it("passes other URLs through", () => {
    expect(sizedImage("https://i.scdn.co/image/x", 40)).toEqual({ src: "https://i.scdn.co/image/x" });
    expect(sizedImage("blob:abc", 40)).toEqual({ src: "blob:abc" });
  });
});

describe("attachmentImage", () => {
  it("resizes when the server makes variants", () => {
    expect(attachmentImage({ url: "/api/attachments/9", thumbnail_url: "/api/attachments/9?w=512" }, 56).src)
      .toBe("https://chat.test/api/attachments/9?w=64");
  });

  it("asks for enough to cover a square when the size is known", () => {
    const wide = { url: "/api/attachments/9", thumbnail_url: "/api/attachments/9?w=512", width: 1000, height: 250 };
    expect(attachmentImage(wide, 56, { cover: true })).toEqual({
      src: "https://chat.test/api/attachments/9?w=256",
      srcSet: "https://chat.test/api/attachments/9?w=256 1x, https://chat.test/api/attachments/9?w=512 2x",
    });
    expect(attachmentImage({ ...wide, width: 250, height: 1000 }, 56, { cover: true }).src)
      .toBe("https://chat.test/api/attachments/9?w=256");
    expect(attachmentImage(wide, 56).src).toBe("https://chat.test/api/attachments/9?w=64");
    expect(attachmentImage({ ...wide, width: undefined, height: undefined }, 56, { cover: true }).src)
      .toBe("https://chat.test/api/attachments/9?w=64");
    expect(attachmentImage({ ...wide, width: 20000, height: 10 }, 240, { cover: true }))
      .toEqual({ src: "https://chat.test/api/attachments/9?w=1600" });
  });

  it("uses a legacy thumbnail or the original otherwise", () => {
    expect(attachmentImage({ url: "/api/attachments/9", thumbnail_url: "/api/attachments/9/thumbnail" }, 56))
      .toEqual({ src: "https://chat.test/api/attachments/9/thumbnail" });
    expect(attachmentImage({ url: "/api/attachments/9" }, 56)).toEqual({ src: "https://chat.test/api/attachments/9" });
  });
});