import { describe, expect, it } from "vitest";
import { panelToParam, paramToPanel } from "./panel-param";

describe("panel param", () => {
  it("round-trips every panel kind", () => {
    for (const p of [
      { kind: "threads" }, { kind: "search" }, { kind: "reminders" },
      { kind: "thread", threadId: "9", parentId: "7" }, { kind: "thread", threadId: "9" },
      { kind: "post", postId: "3", forumId: "2" }, { kind: "media", attachmentId: "5" },
    ] as const) expect(paramToPanel(panelToParam(p))).toEqual(p);
  });
  it("null and garbage mean no panel (reload state)", () => {
    expect(panelToParam(null)).toBeNull();
    expect(paramToPanel(null)).toBeNull();
    expect(paramToPanel("thread:")).toBeNull();
    expect(paramToPanel("nope:1")).toBeNull();
  });
});
