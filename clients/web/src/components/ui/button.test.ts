import { describe, expect, it } from "vitest";
import { buttonVariants } from "./button";

describe("buttonVariants on touch", () => {
  it.each(["icon", "icon-xs", "icon-sm", "icon-lg"] as const)("%s gets a 44px hit area", (size) => {
    const c = buttonVariants({ size });
    expect(c).toContain("pointer-coarse:min-h-[44px]");
    expect(c).toContain("pointer-coarse:min-w-[44px]");
  });
  it.each(["default", "xs", "sm", "lg"] as const)("%s text button gets 44px height", (size) => {
    expect(buttonVariants({ size })).toContain("pointer-coarse:min-h-[44px]");
  });
});
