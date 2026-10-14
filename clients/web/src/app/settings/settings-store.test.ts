import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSettings, setSettingsGated, setSettingsNavigate, settingsStore } from "./settings-store";

describe("settings store", () => {
  beforeEach(() => settingsStore.setState({ section: "profile", notice: undefined }));
  afterEach(() => {
    setSettingsNavigate(null);
    setSettingsGated(false);
    vi.unstubAllGlobals();
  });

  it("opens on a section with a notice", () => {
    openSettings("connections", "Twitch is connected.");
    expect(settingsStore.getState()).toEqual({ section: "connections", notice: "Twitch is connected." });
  });

  it("navigates to the desktop page, or to /you on phones", () => {
    const go = vi.fn();
    setSettingsNavigate(go);
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    openSettings("appearance");
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    openSettings("sessions");
    expect(go.mock.calls).toEqual([["/settings/appearance"], ["/you/sessions"]]);
  });

  it("targets /settings on phones while the rules gate blocks /you", () => {
    const go = vi.fn();
    setSettingsNavigate(go);
    setSettingsGated(true);
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    openSettings("profile");
    expect(go).toHaveBeenCalledWith("/settings/profile");
  });
});
