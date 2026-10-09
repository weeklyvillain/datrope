import { beforeEach, describe, expect, it } from "vitest";
import { closePanel, openPanel, panelStore, setSearchQuery } from "./panel";

describe("panel store", () => {
  beforeEach(() => panelStore.setState({ panel: null, query: "" }));

  it("opens and closes panels", () => {
    openPanel({ kind: "profile", userId: "7" });
    expect(panelStore.getState().panel).toEqual({ kind: "profile", userId: "7" });
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
});
