import * as lucide from "lucide-react";
import { describe, expect, it } from "vitest";
import * as barrel from "./index";

// Every icon file except the base. Each exports exactly one component.
const files = import.meta.glob<Record<string, unknown>>(["./*.tsx", "!./icon-base.tsx", "!./*.test.tsx"], { eager: true });
const animated = Object.values(files).map((mod) => Object.entries(mod)[0]);
const exports = Object.entries(barrel) as [string, unknown][];

describe("icons barrel", () => {
  it("plain names are static lucide icons", () => {
    const plain = exports.filter(([name]) => !name.startsWith("Animated"));
    expect(plain.length).toBeGreaterThan(0);
    for (const [name, Icon] of plain) expect(Icon, name).toBe(lucide[name as keyof typeof lucide]);
  });

  it("every animated icon is opt-in as Animated<Name>", () => {
    for (const [name, Icon] of animated) expect(barrel[`Animated${name}` as keyof typeof barrel], name).toBe(Icon);
  });
});
