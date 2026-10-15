import { describe, expect, it } from "vitest";
import { expiresLabel, fileFlags } from "./expiry";

const now = Date.parse("2026-10-14T12:00:00Z");
const att = (o: object) => ({ expired: false, keep: false, ...o });

describe("expiry", () => {
  it("says how long a file has left", () => {
    expect(expiresLabel("2026-10-17T12:00:00Z", now)).toBe("Expires in 3 days");
    expect(expiresLabel("2026-10-15T11:00:00Z", now)).toBe("Expires in 23 hours");
    expect(expiresLabel("2026-10-14T12:30:00Z", now)).toBe("Expires within the hour");
  });
  it("summarises a message's files", () => {
    expect(fileFlags([att({ expires_at: "x" }), att({})])).toEqual({ expiring: true, kept: false, removable: true });
    expect(fileFlags([att({ keep: true })])).toEqual({ expiring: false, kept: true, removable: true });
    expect(fileFlags([att({ expired: true })])).toEqual({ expiring: false, kept: false, removable: false });
  });
});
