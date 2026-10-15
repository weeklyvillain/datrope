import { describe, expect, it } from "vitest";
import { rerollBody, teamColor, teamOf, validDraw } from "./teams";

const draw = { channel_id: "5", by: "1", teams: [["1", "3"], ["2"]], bench: ["4"], per_team: 0, at: "" };

describe("teams", () => {
  it("finds a person's team", () => {
    expect(teamOf(draw, "3")).toBe(0);
    expect(teamOf(draw, "2")).toBe(1);
    expect(teamOf(draw, "4")).toBe(-1); // bench
  });
  it("colours teams with tokens, cycling after 8", () => {
    expect(teamColor(0)).toBe("var(--team-1)");
    expect(teamColor(8)).toBe("var(--team-1)");
  });
  it("checks a setup before sending", () => {
    expect(validDraw({ teams: 2, perTeam: 0, picked: 3 })).toBeNull();
    expect(validDraw({ teams: 3, perTeam: 0, picked: 2 })).toBe("Pick at least as many people as teams.");
    expect(validDraw({ teams: 2, perTeam: 3, picked: 5 })).toBe("Not enough people for 2 full teams of 3.");
  });
  it("re-rolls the shown draw: its shape, its people", () => {
    expect(rerollBody(draw, ["1", "2", "3", "4"])).toEqual({ teams: 2, per_team: undefined, user_ids: ["1", "3", "2", "4"] });
    expect(rerollBody({ ...draw, per_team: 2 }, ["1", "2", "3", "4"])).toEqual({ teams: 2, per_team: 2, user_ids: ["1", "3", "2", "4"] });
  });
  it("re-rolls without people who left the call, and never adds newcomers", () => {
    expect(rerollBody(draw, ["1", "2", "4", "7"])).toEqual({ teams: 2, per_team: undefined, user_ids: ["1", "2", "4"] });
  });
  it("copes with the nullable generated types", () => {
    expect(rerollBody({ ...draw, teams: [["1"], null], bench: null }, ["1"])).toEqual({ teams: 2, per_team: undefined, user_ids: ["1"] });
  });
});
