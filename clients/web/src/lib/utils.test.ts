import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn type scale", () => {
  it("lets scale sizes override text-sm", () => {
    expect(cn("text-sm", "text-ui")).toBe("text-ui");
  });
  it("keeps a scale size next to a colour", () => {
    expect(cn("text-ui text-primary")).toBe("text-ui text-primary");
  });
  it("drops text-xs but keeps size and colour", () => {
    expect(cn("text-xs", "text-caption text-foreground")).toBe("text-caption text-foreground");
  });
});
