import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

describe("readable line length", () => {
  it("caps message prose at 80ch", () => {
    const src = readFileSync(new URL("./app/MessageList.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/wrap-anywhere max-w-\[80ch\]/);
  });
  it("caps welcome prose at 80ch", () => {
    const src = readFileSync(new URL("./app/welcome/WelcomeMarkdown.tsx", import.meta.url), "utf8");
    expect(src).toContain("max-w-[80ch]");
  });
});

const hex = (name: string) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
const lum = (h: string) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

describe("contrast", () => {
  it("form control borders reach 3:1 on background and card", () => {
    expect(ratio(hex("input")!, hex("background")!)).toBeGreaterThanOrEqual(3);
    expect(ratio(hex("input")!, hex("card")!)).toBeGreaterThanOrEqual(3);
  });
  it("destructive text reaches 4.5:1 on card and popover", () => {
    expect(ratio(hex("destructive")!, hex("card")!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex("destructive")!, hex("popover")!)).toBeGreaterThanOrEqual(4.5);
  });
  it("muted text reaches 4.5:1 on background, card, sidebar and muted", () => {
    for (const bg of ["background", "card", "sidebar", "muted"]) expect(ratio(hex("muted-foreground")!, hex(bg)!)).toBeGreaterThanOrEqual(4.5);
  });
  it("focus rings are solid", () => {
    const button = readFileSync(new URL("./components/ui/button.tsx", import.meta.url), "utf8");
    expect(button).not.toContain("ring-ring/50");
  });
});

describe("lazy images", () => {
  // Each <img ...> runs up to its self-closing "/>", so "=>" inside attribute expressions is fine.
  const imgTags = (src: string) => {
    const tags = src.match(/<img\b[\s\S]*?\/>/g) ?? [];
    expect(tags.length).toBe(src.match(/<img\b/g)?.length ?? 0);
    return tags;
  };
  it.each(["app/gallery/AlbumsView.tsx", "app/people/ProfileCard.tsx", "app/server-settings/Emoji.tsx"])("%s lazy-loads its images", (f) => {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    const imgs = imgTags(src);
    expect(imgs.length).toBeGreaterThan(0);
    for (const tag of imgs) expect(tag).toContain('loading="lazy"');
  });
  it("ImageViewer: only the main viewed image is eager; thumbnails are lazy", () => {
    const src = readFileSync(new URL("./app/attachments/ImageViewer.tsx", import.meta.url), "utf8");
    const imgs = imgTags(src);
    const main = imgs.filter((t) => t.includes("object-contain"));
    expect(main).toHaveLength(1);
    expect(main[0]).toContain('loading="eager"');
    const others = imgs.filter((t) => t !== main[0]);
    expect(others.length).toBeGreaterThan(0);
    for (const tag of others) expect(tag).toContain('loading="lazy"');
  });
});

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = `${dir}/${f}`;
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
describe("type scale", () => {
  it("defines the scale tokens", () => {
    for (const t of ["caption", "meta", "ui", "body", "title", "heading"]) expect(css).toMatch(new RegExp(`--text-${t}:`));
  });
  it("uses no arbitrary pixel font sizes between 10 and 16 px", () => {
    const root = fileURLToPath(new URL("./", import.meta.url));
    const offenders = walk(root.replaceAll("\\", "/").replace(/\/$/, ""))
      .filter((p) => !p.includes("/components/ui/"))
      .filter((p) => /text-\[1[0-6]px\]/.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("motion", () => {
  it("defines duration and easing tokens", () => {
    for (const t of ["--dur-fast: 120ms", "--dur-base: 180ms", "--dur-slow: 240ms"]) expect(css).toContain(t);
    expect(css).toMatch(/--ease-out-quint:\s*cubic-bezier\(0\.22, 1, 0\.36, 1\)/);
  });
  it("reduces Radix animations and the message flash", () => {
    const block = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toContain("[data-state]");
    expect(block).toContain(".message-flash");
    expect(block).toContain("scroll-behavior: auto");
  });
  it("shows the reduced-motion message flash instantly", () => {
    const block = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toMatch(/\.message-flash\s*\{[^}]*transition:\s*none/);
  });
  it("uses no hard-coded durations in the ui primitives", () => {
    const dir = fileURLToPath(new URL("./components/ui", import.meta.url)).replaceAll("\\", "/");
    const offenders = walk(dir).filter((p) => /duration-(200|300|500)(?![0-9])/.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("component vocabulary", () => {
  const app = fileURLToPath(new URL("./app/", import.meta.url)).replaceAll("\\", "/").replace(/\/$/, "");
  it("has no raw range inputs outside ui/", () => {
    const offenders = walk(app).filter((p) => /type="range"/.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });
  it("keeps raw buttons to the documented exceptions", () => {
    // NameButton (forwardRef popover trigger), title overlay button, inline @mention text (Markdown pins its bare class)
    const allowed = ["MessageList.tsx", "TopBar.tsx", "MentionTrigger.tsx"];
    const offenders = walk(app)
      .filter((p) => /<button\b/.test(readFileSync(p, "utf8")))
      .filter((p) => !allowed.some((a) => p.endsWith(a)));
    expect(offenders).toEqual([]);
  });
});
