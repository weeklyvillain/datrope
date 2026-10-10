import { beforeEach, describe, expect, it } from "vitest";
import { closePanel, closeProfile, openPanel, openProfile, panelStore, setSearchQuery } from "./panel";

describe("panel store", () => {
  beforeEach(() => panelStore.setState({ panel: null, query: "", profile: null }));

  it("opens and closes panels", () => {
    openPanel({ kind: "threads" });
    expect(panelStore.getState().panel).toEqual({ kind: "threads" });
    closePanel();
    expect(panelStore.getState().panel).toBeNull();
  });

  it("keeps the search query when the panel closes", () => {
    setSearchQuery("hello");
    openPanel({ kind: "search" });
    closePanel();
    expect(panelStore.getState().query).toBe("hello");
  });

  it("opens a profile over the side panel without closing it", () => {
    openPanel({ kind: "search" });
    openProfile("7");
    expect(panelStore.getState()).toMatchObject({ panel: { kind: "search" }, profile: "7" });
    openProfile("8");
    expect(panelStore.getState().profile).toBe("8");
    closeProfile();
    expect(panelStore.getState()).toMatchObject({ panel: { kind: "search" }, profile: null });
  });
});
