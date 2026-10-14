import { describe, expect, it } from "vitest";
import { composerTools } from "./composer-tools";

describe("composerTools", () => {
  it("desktop keeps attach, code and emoji inline", () =>
    expect(composerTools(false, true)).toEqual({ inline: ["attach", "code", "emoji"], menu: [] }));
  it("desktop without attach drops attach", () =>
    expect(composerTools(false, false)).toEqual({ inline: ["code", "emoji"], menu: [] }));
  it("phone moves code into the attach menu", () =>
    expect(composerTools(true, true)).toEqual({ inline: ["attach", "emoji"], menu: ["upload", "code"] }));
  it("phone without attach keeps code inline", () =>
    expect(composerTools(true, false)).toEqual({ inline: ["code", "emoji"], menu: [] }));
});
