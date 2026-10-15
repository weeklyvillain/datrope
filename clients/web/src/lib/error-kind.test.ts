import { ApiError } from "@datrope/core";
import { describe, expect, it } from "vitest";
import { errorKind, isUnreachable } from "./error-kind";

describe("errorKind", () => {
  it("sends router and API 404s to the not-found page", () => {
    expect(errorKind({ status: 404, statusText: "Not Found", internal: true, data: "" })).toBe("not-found");
    expect(errorKind(new ApiError(404, "NOT_FOUND", "no such album"))).toBe("not-found");
  });

  it("sends 403s to the no-access page", () => {
    expect(errorKind(new ApiError(403, "FORBIDDEN", "missing permission"))).toBe("no-access");
  });

  it("treats everything else as a crash", () => {
    expect(errorKind(new TypeError("x is undefined"))).toBe("crash");
    expect(errorKind(new ApiError(500, "INTERNAL", "boom"))).toBe("crash");
    expect(errorKind("thrown string")).toBe("crash");
  });
});

describe("isUnreachable", () => {
  it("means no answer or a 5xx, not a signed-out 401", () => {
    expect(isUnreachable(new TypeError("Failed to fetch"))).toBe(true);
    expect(isUnreachable(new ApiError(502, "UNKNOWN", "Bad Gateway"))).toBe(true);
    expect(isUnreachable(new ApiError(401, "UNAUTHORIZED", "sign in"))).toBe(false);
  });
});
