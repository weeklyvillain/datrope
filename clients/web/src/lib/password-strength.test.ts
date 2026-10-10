import { describe, expect, it } from "vitest";
import { passwordStrength } from "./password-strength";

describe("passwordStrength", () => {
  it("scores length and variety", () => {
    expect(passwordStrength("short")).toBe(0);
    expect(passwordStrength("password")).toBe(1);
    expect(passwordStrength("password12")).toBe(2);
    expect(passwordStrength("Password12!")).toBe(3);
    expect(passwordStrength("Password12!long")).toBe(4);
  });
});
