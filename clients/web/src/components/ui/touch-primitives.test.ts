import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");

describe("form primitives on touch", () => {
  it.each(["input.tsx", "native-select.tsx"])("%s is 44px tall on touch", (f) => {
    expect(src(f)).toContain("pointer-coarse:min-h-[44px]");
  });
  it("switch gets a 44px hit area on touch", () => {
    const s = src("switch.tsx");
    expect(s).toContain("pointer-coarse:after:absolute");
    expect(s).toContain("pointer-coarse:after:-inset-y-[14px]");
  });
});
