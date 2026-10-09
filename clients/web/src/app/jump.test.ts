import { beforeEach, describe, expect, it, vi } from "vitest";

const { getChannel, state } = vi.hoisted(() => ({
  getChannel: vi.fn(),
  state: { channels: {} as Record<string, unknown> },
}));
vi.mock("../session", () => ({ client: { getChannel, store: { getState: () => state } } }));

import { openMessage } from "./jump";
import { panelStore } from "./side-panel/panel";

describe("openMessage", () => {
  beforeEach(() => {
    getChannel.mockReset();
    state.channels = { p1: { id: "p1", type: "text", name: "general" } };
    panelStore.setState({ panel: null });
  });

  it("opens a known thread under its parent", async () => {
    const navigate = vi.fn();
    await openMessage(navigate, { id: "t1", type: "thread", name: "Plans", parent_id: "p1", parent_name: "general" }, "m1");
    expect(getChannel).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/channels/p1");
    expect(panelStore.getState().panel).toEqual({ kind: "thread", threadId: "t1", parentId: "p1" });
  });

  it("fetches a thread it does not know to find the parent", async () => {
    getChannel.mockImplementation(async () => {
      state.channels.t2 = { id: "t2", type: "thread", name: "Plans", parent_channel_id: "p1" };
    });
    const navigate = vi.fn();
    await openMessage(navigate, { id: "t2", type: "thread", name: "" }, "m2");
    expect(getChannel).toHaveBeenCalledWith("t2");
    expect(navigate).toHaveBeenCalledWith("/channels/p1");
    expect(panelStore.getState().panel).toEqual({ kind: "thread", threadId: "t2", parentId: "p1" });
  });

  it("goes nowhere when the thread cannot be fetched", async () => {
    getChannel.mockRejectedValue(new Error("nope"));
    const navigate = vi.fn();
    await openMessage(navigate, { id: "t3", type: "thread", name: "" }, "m3");
    expect(navigate).not.toHaveBeenCalled();
    expect(panelStore.getState().panel).toBeNull();
  });
});
