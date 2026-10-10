import type { Attachment } from "@datrope/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GifMedia } from "./GifMedia";

// The session module creates the client from window.location, which Node lacks.
vi.mock("@/session", () => ({ client: { url: (p: string) => `https://chat.test${p}` } }));

const gif: Attachment = {
  id: "9", channel_id: "3", filename: "Cat.mp4", content_type: "video/mp4", size: 10, inline: false,
  url: "/api/attachments/9", width: 498, height: 373, gif: true,
};

describe("GifMedia", () => {
  it("plays an MP4 GIF muted and looped, without controls", () => {
    const html = renderToStaticMarkup(<GifMedia attachment={gif} />);
    expect(html).toContain("<video");
    for (const attr of ['muted=""', 'loop=""', 'autoplay=""', 'playsinline=""',
      'src="https://chat.test/api/attachments/9"', 'aria-label="Cat.mp4"', 'width="400"', 'height="300"']) {
      expect(html).toContain(attr);
    }
    expect(html).not.toContain("controls");
  });

  it("shows a WebP or GIF file as an image", () => {
    const html = renderToStaticMarkup(<GifMedia attachment={{ ...gif, filename: "Cat.webp", content_type: "image/webp" }} />);
    expect(html).toContain("<img");
    expect(html).toContain('alt="Cat.webp"');
    expect(html).not.toContain("<video");
  });

  it("works without a known size", () => {
    const html = renderToStaticMarkup(<GifMedia attachment={{ ...gif, width: undefined, height: undefined }} />);
    expect(html).toContain("<video");
    expect(html).not.toContain("width=");
  });
});
