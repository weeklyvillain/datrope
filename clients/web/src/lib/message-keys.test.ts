import { describe, expect, it } from "vitest";
import { messageKeyAction } from "./message-keys";

const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean }> = {}) =>
  ({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe("messageKeyAction", () => {
  it("maps keys on a focused row", () => {
    expect(messageKeyAction(k("ArrowUp"), true)).toBe("prev");
    expect(messageKeyAction(k("ArrowDown"), true)).toBe("next");
    expect(messageKeyAction(k("Home"), true)).toBe("first");
    expect(messageKeyAction(k("End"), true)).toBe("last");
    expect(messageKeyAction(k("Enter"), true)).toBe("menu");
    expect(messageKeyAction(k("r"), true)).toBe("reply");
    expect(messageKeyAction(k("R"), true)).toBe("reply");
    expect(messageKeyAction(k("e"), true)).toBe("edit");
    expect(messageKeyAction(k("t"), true)).toBe("thread");
    expect(messageKeyAction(k("p"), true)).toBe("pin");
    expect(messageKeyAction(k("+"), true)).toBe("react");
    expect(messageKeyAction(k("Delete"), true)).toBe("delete");
    expect(messageKeyAction(k("Escape"), true)).toBe("composer");
  });
  it("leaves keys inside a row's own controls alone (child target)", () => {
    for (const key of ["r", "e", "Enter", "ArrowUp", "Delete", "+"]) expect(messageKeyAction(k(key), false)).toBeNull();
  });
  it("ignores modified keys and IME composition", () => {
    expect(messageKeyAction(k("r", { ctrlKey: true }), true)).toBeNull();
    expect(messageKeyAction(k("ArrowUp", { altKey: true }), true)).toBeNull(); // Alt+↑ is channel switching
    expect(messageKeyAction(k("e", { metaKey: true }), true)).toBeNull();
    expect(messageKeyAction(k("r", { isComposing: true }), true)).toBeNull();
  });
  it("ignores other keys", () => expect(messageKeyAction(k("x"), true)).toBeNull());
});
