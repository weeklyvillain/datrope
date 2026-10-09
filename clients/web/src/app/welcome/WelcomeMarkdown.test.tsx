import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WelcomeMarkdown } from "./WelcomeMarkdown";

// The session module creates the client from window.location, which Node lacks; plain Markdown blocks need neither.
vi.mock("@/session", () => ({ client: {}, useApp: () => undefined }));

const html = (markdown: string) => renderToStaticMarkup(<WelcomeMarkdown markdown={markdown} />);

describe("welcome Markdown", () => {
  it("hides ||spoilers|| behind a button", () => {
    const out = html("Wrap them like ||this|| please");
    expect(out).toContain('class="spoiler"');
    expect(out).toContain('role="button"');
    expect(out).toContain('aria-label="Spoiler, select to show"');
    expect(out).toContain(">this</span>");
    expect(out).not.toContain("||");
  });

  it("leaves spoiler syntax in code alone", () => {
    expect(html("`||literal||`")).toContain("||literal||");
  });

  it("leaves :emoji: and @mentions as text", () => {
    const out = html("hi :smile: @bob");
    expect(out).toContain("hi :smile: @bob");
    expect(out).not.toContain("mention");
  });
});
