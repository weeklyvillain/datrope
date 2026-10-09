import { beforeEach, describe, expect, it } from "vitest";
import { closeSettings, openSettings, settingsStore, showSection } from "./settings-store";

describe("settings store", () => {
  beforeEach(() => settingsStore.setState({ open: false, section: "profile" }));

  it("opens on the profile by default", () => {
    openSettings();
    expect(settingsStore.getState()).toEqual({ open: true, section: "profile" });
  });

  it("opens on a section, switches, and closes keeping the section", () => {
    openSettings("appearance");
    showSection("sessions");
    closeSettings();
    expect(settingsStore.getState()).toEqual({ open: false, section: "sessions" });
  });
});
