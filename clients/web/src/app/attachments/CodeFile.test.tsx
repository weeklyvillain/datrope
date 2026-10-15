import type { Attachment } from "@datrope/core";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadHighlighter } from "@/lib/highlighter";
import { CodeFileView, isCodeFile } from "./CodeFile";

// The session module creates the client from window.location, which Node lacks.
vi.mock("@/session", () => ({
  client: { url: (p: string) => `https://chat.test${p}` },
  formatBytes: (n: number) => `${n} B`,
}));

const file: Attachment = {
  id: "5", channel_id: "3", filename: "main.go", content_type: "text/plain; charset=utf-8", size: 120, inline: false,
  url: "/api/attachments/5", keep: false, expired: false,
};
const lines = (n: number) => Array.from({ length: n }, (_, i) => `// line ${i}`).join("\r\n") + "\r\n";

describe("isCodeFile", () => {
  it("previews small text files only", () => {
    expect(isCodeFile(file)).toBe(true);
    expect(isCodeFile({ ...file, content_type: "text/html; charset=utf-8" })).toBe(true);
    expect(isCodeFile({ ...file, size: 1_048_577 })).toBe(false);
    expect(isCodeFile({ ...file, content_type: "application/octet-stream" })).toBe(false);
    expect(isCodeFile({ ...file, content_type: "image/png" })).toBe(false);
  });
});

describe("CodeFileView", () => {
  beforeAll(async () => {
    await loadHighlighter();
  });

  it("shows the first 15 lines highlighted, with the full count", () => {
    const out = renderToStaticMarkup(<CodeFileView attachment={file} text={lines(20)} />);
    expect(out).toContain("main.go");
    expect(out).toContain("// line 14");
    expect(out).not.toContain("// line 15");
    expect(out).toContain("Show all 20 lines");
    expect(out).not.toContain("\r");
    expect(out).toContain('download="main.go"');
  });

  it("previews at most 5000 characters of a huge line", () => {
    const out = renderToStaticMarkup(<CodeFileView attachment={file} text={"x".repeat(20_000)} />);
    expect(out).toContain("x".repeat(5_000));
    expect(out).not.toContain("x".repeat(5_001));
  });

  it("has no Show all for a short file", () => {
    expect(renderToStaticMarkup(<CodeFileView attachment={file} text={lines(15)} />)).not.toContain("Show all");
  });

  it("shows a loading state before the text arrives", () => {
    expect(renderToStaticMarkup(<CodeFileView attachment={file} text={undefined} />)).toContain('aria-busy="true"');
  });

  it("shows an HTML file as text", () => {
    const out = renderToStaticMarkup(<CodeFileView attachment={{ ...file, filename: "x.html" }} text={'<img src=x onerror="alert(1)">'} />);
    expect(out).not.toContain("<img");
  });
});
