import { describe, expect, it } from "vitest";
import { readMembersPref, writeMembersPref } from "./members-pref";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("members pref", () => {
  it("defaults to shown", () => expect(readMembersPref(mem())).toBe(true));
  it("round-trips", () => {
    const s = mem();
    writeMembersPref(false, s);
    expect(readMembersPref(s)).toBe(false);
    writeMembersPref(true, s);
    expect(readMembersPref(s)).toBe(true);
  });
  it("survives storage that throws", () => {
    const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readMembersPref(bad)).toBe(true);
    expect(() => writeMembersPref(false, bad)).not.toThrow();
  });
});
