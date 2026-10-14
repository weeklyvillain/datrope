import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("edge to edge", () => {
  it("draws under the notch and resizes with the keyboard", () => {
    expect(html).toMatch(/viewport-fit=cover/);
    expect(html).toMatch(/interactive-widget=resizes-content/);
    expect(html).toMatch(/apple-mobile-web-app-status-bar-style" content="black-translucent"/);
  });
  it("defines safe-area utilities", () => {
    for (const u of ["pt-safe", "pb-safe", "pl-safe", "pr-safe", "bottom-safe"]) expect(css).toContain(`@utility ${u}`);
  });
  it("keeps desktop padding next to safe-area insets", () => {
    for (const f of ["pages/Invite.tsx", "app/NotAMember.tsx"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(src).toMatch(/max\([^)]*,env\(safe-area-inset-top\)\)/);
      expect(src).toMatch(/max\([^)]*,env\(safe-area-inset-bottom\)\)/);
    }
  });
});

describe("full-screen dialogs", () => {
  it("the image viewer opts out of the dialog max height and scrolling", () => {
    const src = readFileSync(new URL("./app/attachments/ImageViewer.tsx", import.meta.url), "utf8");
    expect(src).toContain("h-dvh max-h-none");
    expect(src).toContain("overflow-hidden translate-x-0");
  });
});

describe("scrolling and touch behaviour", () => {
  it("stops scroll chaining and pull-to-refresh", () => {
    expect(css).toMatch(/html,\s*body\s*\{[^}]*overscroll-behavior:\s*none/);
  });
  it("suppresses the iOS link callout on long-press of messages and channel rows", () => {
    const read = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    expect(read("app/MessageList.tsx")).toContain("pointer-coarse:[-webkit-touch-callout:none]");
    expect(read("app/MessageList.tsx")).toContain("touch-pan-y");
    expect(read("app/MessageList.tsx")).not.toContain("touch-manipulation");
    expect(read("app/sidebar/ChannelTree.tsx")).toContain("pointer-coarse:[-webkit-touch-callout:none]");
  });
});
