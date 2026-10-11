import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WebhookEmbedCard, embedColor, fieldRows } from "./WebhookEmbed";

// The session module needs window.location; Markdown needs the store. Neither is under test here.
vi.mock("@/session", () => ({ client: { url: (p: string) => p } }));
vi.mock("@/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <span className="md">{text}</span> }));

const f = (name: string, inline = true) => ({ name, value: `${name} value`, inline });

describe("fieldRows", () => {
  it("puts up to three inline fields in a row", () => {
    const rows = fieldRows([f("a"), f("b"), f("c"), f("d"), f("e", false), f("g"), f("h")]);
    expect(rows.map((r) => r.map((x) => x.name))).toEqual([["a", "b", "c"], ["d"], ["e"], ["g", "h"]]);
  });

  it("never puts an inline field next to one that is not", () => {
    expect(fieldRows([f("a", false), f("b")]).map((r) => r.length)).toEqual([1, 1]);
  });
});

describe("WebhookEmbedCard", () => {
  it("renders every part", () => {
    const html = renderToStaticMarkup(<WebhookEmbedCard embed={{
      title: "v1.2.3", url: "https://example.com/r", description: "**green**", color: 0x2ecc71, timestamp: "2026-10-10T12:00:00Z",
      author: { name: "GitHub", url: "https://github.com", icon_url: "/api/messages/1/images/a" },
      fields: [f("Branch"), f("Commit"), f("Runner")],
      thumbnail: { url: "/api/messages/1/images/b" }, image: { url: "/api/messages/1/images/c" },
      footer: { text: "CI", icon_url: "/api/messages/1/images/d" },
    }} />);
    expect(html).toContain('style="background:#2ecc71"');
    expect(html).toContain('href="https://example.com/r"');
    expect(html).toContain(">v1.2.3</a>");
    expect(html).toContain('href="https://github.com"');
    expect(html).toContain('<span class="md">**green**</span>');
    expect(html).toContain("grid-template-columns:repeat(3, minmax(0, 1fr))");
    for (const [src, w] of [["a", 32], ["b", 128], ["c", 512], ["d", 32]]) expect(html).toContain(`src="/api/messages/1/images/${src}?w=${w}"`);
    expect(html).toMatch(/datetime="2026-10-10T12:00:00Z"/i);
    expect(html).toContain(">CI</span>");
  });

  it("leaves out what is missing", () => {
    const html = renderToStaticMarkup(<WebhookEmbedCard embed={{ description: "only text" }} />);
    expect(html).toContain("only text");
    expect(html).toContain("bg-border");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<time");
  });

  it("has a thumbnail column only when there is a thumbnail", () => {
    const plain = renderToStaticMarkup(<WebhookEmbedCard embed={{ description: "only text" }} />);
    expect(plain).not.toContain("grid-cols-[minmax(0,1fr)_auto]");
    expect(plain).not.toContain("gap-x-4 px-3");
    const thumb = renderToStaticMarkup(<WebhookEmbedCard embed={{ description: "text", thumbnail: { url: "/t" } }} />);
    expect(thumb).toContain("grid-cols-[minmax(0,1fr)_auto] gap-x-4");
  });

  it("writes the colour as six hex digits", () => {
    expect(embedColor(0)).toBe("#000000");
    expect(embedColor(0xff)).toBe("#0000ff");
    expect(embedColor(undefined)).toBeUndefined();
  });
});
