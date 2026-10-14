import { describe, expect, it } from "vitest";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PILL } from "./reaction-pill";

describe("reaction pill on touch", () => {
  it("keeps the 26px visual height instead of the Button 44px touch min-height", () => {
    const c = cn(buttonVariants({}), PILL);
    expect(c).toContain("pointer-coarse:min-h-0");
    expect(c).not.toContain("pointer-coarse:min-h-[44px]");
  });
});
