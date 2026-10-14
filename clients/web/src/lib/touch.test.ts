import { describe, expect, it } from "vitest";
import { enterAction } from "./touch";

const k = (o: Partial<Parameters<typeof enterAction>[0]> = {}) =>
  ({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...o });

describe("enterAction", () => {
  it("ignores other keys and IME composition", () => {
    expect(enterAction(k({ key: "a" }), false)).toBeNull();
    expect(enterAction(k({ isComposing: true }), false)).toBeNull();
  });
  it("desktop: Enter sends, Shift+Enter is a newline", () => {
    expect(enterAction(k(), false)).toBe("send");
    expect(enterAction(k({ shiftKey: true }), false)).toBe("newline");
  });
  it("touch only: Enter is a newline", () => expect(enterAction(k(), true)).toBe("newline"));
  it("Ctrl/Cmd+Enter always sends", () => {
    expect(enterAction(k({ ctrlKey: true }), true)).toBe("send");
    expect(enterAction(k({ metaKey: true }), false)).toBe("send");
  });
});
