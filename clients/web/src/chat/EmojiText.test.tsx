import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EmojiText } from "./EmojiText";

vi.mock("@/session", () => ({
  client: { url: (u: string) => u },
  useApp: (sel: (s: unknown) => unknown) => sel({ emoji: { 7: { id: "7", name: "Parrot", url: "/api/emoji/7" } } }),
}));
vi.mock("./emoji-data", () => ({ useEmojiData: () => ({ byShortcode: new Map([["smile", "😄"]]) }) }));

const html = (text: string) => renderToStaticMarkup(<EmojiText text={text} />);

describe("EmojiText", () => {
  it("shows custom emoji as images and shortcodes as Unicode", () => {
    const out = html("hi :parrot: and :smile: but :nope:");
    expect(out).toContain('src="/api/emoji/7"');
    expect(out).toContain('alt=":parrot:"');
    expect(out).toContain("and 😄 but :nope:");
  });

  it("leaves other text alone, Markdown included", () => {
    expect(html("**not bold** <b>x</b>")).toBe("**not bold** &lt;b&gt;x&lt;/b&gt;");
  });
});
