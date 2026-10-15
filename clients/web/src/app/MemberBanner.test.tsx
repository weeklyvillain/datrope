import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/session", () => ({ client: { url: (p: string) => `https://x${p}` } }));
const { MemberBanner } = await import("./MemberBanner");

describe("MemberBanner", () => {
  it("renders nothing without a banner", () => expect(renderToStaticMarkup(<MemberBanner />)).toBe(""));
  it("renders a decorative, lazy, sized image behind the row", () => {
    const html = renderToStaticMarkup(<MemberBanner url="/api/banners/1" />);
    expect(html).toContain('alt=""');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("w=256");
    expect(html).toContain("opacity-30");
  });
  it("dims further for offline members", () => expect(renderToStaticMarkup(<MemberBanner url="/api/banners/1" dim />)).toContain("opacity-15"));
});
