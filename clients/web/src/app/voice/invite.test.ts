import type { Invite } from "@datrope/core";
import { describe, expect, it } from "vitest";
import { reusableInvite } from "./invite";

const inv = (o: Partial<Invite>): Invite => ({ code: "x", created_at: "", creator_id: "1", uses: 0, ...o });

describe("reusableInvite", () => {
  it("reuses my unlimited, non-expiring invite", () => {
    expect(reusableInvite([inv({ code: "a", creator_id: "2" }), inv({ code: "b" })], "1")).toBe("b");
  });
  it("skips expiring, limited and other people's invites", () => {
    const list = [inv({ code: "a", expires_at: "2030-01-01T00:00:00Z" }), inv({ code: "b", max_uses: 5 }), inv({ code: "c", creator_id: "2" })];
    expect(reusableInvite(list, "1")).toBeUndefined();
  });
  it("never reuses a guest link", () => {
    expect(reusableInvite([inv({ code: "g", guest_ttl_seconds: 3600 })], "1")).toBeUndefined();
  });
  it("handles no list", () => {
    expect(reusableInvite(undefined, "1")).toBeUndefined();
  });
});
