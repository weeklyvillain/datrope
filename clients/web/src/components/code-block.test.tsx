import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { loadHighlighter } from "@/lib/highlighter";
import { CodeBlock } from "./code-block";

const html = (el: JSX.Element) => renderToStaticMarkup(el);

describe("CodeBlock", () => {
  beforeAll(async () => {
    await loadHighlighter();
  });

  it("highlights a known language and labels it", () => {
    const out = html(<CodeBlock code={"const a = 1;"} lang="ts" />);
    expect(out).toContain('class="hljs-keyword"');
    expect(out).toContain(">ts<");
    expect(out).toContain('aria-label="Copy code"');
  });

  it("renders an unknown language as plain text with its label", () => {
    const out = html(<CodeBlock code={"a <- b"} lang="foo" />);
    expect(out).not.toContain("hljs-");
    expect(out).toContain(">foo<");
    expect(out).toContain("a &lt;- b");
  });

  it("skips highlighting past the size cap", () => {
    const out = html(<CodeBlock code={"a".repeat(100_001)} lang="ts" />);
    expect(out).not.toContain("hljs-");
  });

  it("calls a block without a language text", () => {
    expect(html(<CodeBlock code="x" />)).toContain(">text<");
  });

  it("never turns code into markup", () => {
    const out = html(<CodeBlock code={'<img src=x onerror="alert(1)">'} lang="html" />);
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;");
  });

  it("numbers lines when asked", () => {
    expect(html(<CodeBlock code={"a\nb\nc"} lineNumbers />)).toContain("1\n2\n3");
  });

  it("shows a title and actions instead of the language", () => {
    const out = html(<CodeBlock code="x" lang="ts" title="main.ts" actions={<a href="/f">Download</a>} />);
    expect(out).toContain("main.ts");
    expect(out).toContain("Download");
  });
});
