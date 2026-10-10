import type { Channel } from "@datrope/core";
import { beforeEach, describe, expect, it } from "vitest";
import { closeCommands, commandStore, findDM, toggleCommands } from "./command-store";

const user = (id: string) => ({ id, username: `u${id}`, display_name: "" }) as NonNullable<Channel["participants"]>[number];
const dm = (id: string, ...ids: string[]) => ({ id, type: "dm", participants: ids.map(user) }) as Channel;

describe("command store", () => {
  beforeEach(() => commandStore.setState({ open: false }));

  it("toggles and closes", () => {
    toggleCommands();
    expect(commandStore.getState().open).toBe(true);
    toggleCommands();
    expect(commandStore.getState().open).toBe(false);
    toggleCommands();
    closeCommands();
    expect(commandStore.getState().open).toBe(false);
  });
});

describe("findDM", () => {
  const channels = { a: dm("a", "me", "2", "3"), b: dm("b", "me", "2"), c: dm("c", "me", "3") };

  it("finds the one-to-one DM with a user, not a group DM", () => {
    expect(findDM(["a", "b", "c"], channels, "me", "2")).toBe("b");
    expect(findDM(["a", "b", "c"], channels, "me", "3")).toBe("c");
  });

  it("returns undefined when there is none", () => {
    expect(findDM(["a"], channels, "me", "2")).toBeUndefined();
  });
});
