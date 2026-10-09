import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MarkdownView } from "./Markdown";

// The session module creates the client from window.location, which Node lacks; MarkdownView needs neither.
vi.mock("@/session", () => ({ client: {}, useApp: () => undefined }));

const opts = {
  custom: new Map([["parrot", { id: "7", url: "/api/emoji/7" }]]),
  shortcodes: new Map([["smile", "😄"]]),
  users: new Map([["bob", { id: "20", name: "Bob" }], ["me", { id: "10", name: "Me" }]]),
  meId: "10",
};
const html = (text: string) => renderToStaticMarkup(<MarkdownView text={text} options={opts} />);

describe("message Markdown", () => {
  it.each([
    ["**bold** *it* ~~gone~~", "<strong>bold</strong>", "<em>it</em>", "<del>gone</del>"],
    ["`x<y`", "<code>x&lt;y</code>"],
    ["```\nconst a = 1;\n```", "<pre><code>const a = 1;\n</code></pre>"],
    ["> quoted", "<blockquote>"],
    ["- a\n- b", "<ul>", "<li>a</li>"],
    ["[site](https://example.com)", 'href="https://example.com"', 'target="_blank"', 'rel="noopener noreferrer"'],
    ["see https://example.com/x", 'href="https://example.com/x"'],
    ["||secret||", 'class="spoiler"', "secret"],
    ["hi :parrot:", '<img', 'src="/api/emoji/7"', 'alt=":parrot:"'],
    ["hi :smile:", "😄"],
    ["hi :nope:", ":nope:"],
    ["hey @bob and @nobody", 'class="mention"', "@bob", "@nobody"],
    ["ping @me", "data-me"],
    ["# Heading", "Heading"],
    ["line one\nline two", "line one\nline two"],
  ])("%s", (text, ...want) => {
    const out = html(text);
    for (const w of want) expect(out).toContain(w);
  });

  it.each([
    ["<b>raw</b> html", "<b>"],
    ["[x](javascript:alert(1))", "javascript:"],
    ["![alt](https://evil.example/i.png)", "<img"],
    ["# Heading", "<h1"],
    ["`@bob`", 'class="mention"'],
    ["`:parrot:`", "<img"],
  ])("%s is not rendered as markup", (text, absent) => {
    expect(html(text)).not.toContain(absent);
  });
});

describe("inline Markdown (topics)", () => {
  const inline = (text: string) => renderToStaticMarkup(<MarkdownView text={text} options={opts} inline />);

  it("keeps inline formatting on one line, without raw syntax", () => {
    const out = inline("Board games **only**\n\n> no *spoilers*\n- [rules](https://example.com)");
    expect(out).toContain("<strong>only</strong>");
    expect(out).toContain("<em>spoilers</em>");
    expect(out).not.toMatch(/\*\*|<p>|<blockquote>|<li>|<a |<br/);
    expect(out).toContain("rules");
  });
});

describe("search highlights", () => {
  const marked = (text: string, inline = false) =>
    renderToStaticMarkup(<MarkdownView text={text} options={opts} inline={inline} highlight={["wingspan"]} />);

  it("marks terms in text, but not in code or spoilers", () => {
    const out = marked("I have **Wingspan**, `wingspan` and ||wingspan||");
    expect(out).toContain("<strong><mark>Wingspan</mark></strong>");
    expect(out).toContain("<code>wingspan</code>");
    expect(out.match(/<mark>/g)).toHaveLength(1);
  });

  it("marks terms in inline rendering", () => {
    expect(marked("try wingspan", true)).toContain("<mark>wingspan</mark>");
  });
});
