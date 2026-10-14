import { describe, expect, it } from "vitest";
import { shouldKeepFocus } from "./focus";

const node = (kids: unknown[] = []) => ({ contains: (n: unknown) => n === node || kids.includes(n) });
describe("shouldKeepFocus", () => {
  const body = {};
  it("keeps focus that moved elsewhere (e.g. Reply focused the composer)", () => {
    const composer = node();
    expect(shouldKeepFocus(composer, node(), body)).toBe(true);
  });
  it("returns focus when nothing has it", () => {
    expect(shouldKeepFocus(null, node(), body)).toBe(false);
    expect(shouldKeepFocus(body as never, node(), body)).toBe(false);
  });
  it("returns focus when it is still inside the trigger", () => {
    const child = {};
    expect(shouldKeepFocus(child as never, node([child]), body)).toBe(false);
  });
});
