import { describe, expect, it } from "vitest";
import { keyboardInset } from "./keyboard-inset";

describe("keyboardInset", () => {
  it("is 0 without visualViewport", () => expect(keyboardInset(800, null)).toBe(0));
  it("is the part of the layout viewport the keyboard covers (iOS)", () => {
    expect(keyboardInset(812, { height: 476, offsetTop: 0 })).toBe(336);
  });
  it("accounts for a scrolled visual viewport", () => {
    expect(keyboardInset(812, { height: 476, offsetTop: 100 })).toBe(236);
  });
  it("is 0 when the layout viewport already shrank (Android resizes-content)", () => {
    expect(keyboardInset(476, { height: 476, offsetTop: 0 })).toBe(0);
  });
  it("never goes negative and rounds", () => expect(keyboardInset(800, { height: 800.4, offsetTop: 0 })).toBe(0));
});
