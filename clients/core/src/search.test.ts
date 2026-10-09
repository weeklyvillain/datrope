import { describe, expect, it } from "vitest";
import { clearOperators, operatorValue, setOperator } from "./search";

describe("search operators", () => {
  it("sets, replaces and removes one operator", () => {
    expect(setOperator("wingspan", "from", "bob")).toBe("wingspan from:bob");
    expect(setOperator("wingspan FROM:alice in:#games", "from", "bob")).toBe("wingspan in:#games from:bob");
    expect(setOperator("wingspan from:alice", "from", null)).toBe("wingspan");
    expect(setOperator("", "has", "link")).toBe("has:link");
    expect(setOperator("info:x  in:#a", "in", null)).toBe("info:x");
    expect(setOperator("https://x.com from:a", "from", "")).toBe("https://x.com");
  });

  it("reads and clears operators", () => {
    expect(operatorValue("x from:@Alice", "from")).toBe("@Alice");
    expect(operatorValue("x", "in")).toBeUndefined();
    expect(clearOperators("wingspam from:alice has:file  x")).toBe("wingspam x");
  });
});
