import { describe, expect, it } from "vitest";
import { isTabRoot, tabFor } from "./tabs";

describe("phone tabs", () => {
  it.each([
    ["/", "server", true], ["/channels/1", "server", false], ["/gallery", "server", false],
    ["/messages", "messages", true], ["/messages/5", "messages", false],
    ["/mentions", "mentions", true], ["/you", "you", true], ["/you/notifications", "you", false],
    ["/server-settings", "you", false], ["/server-settings/members", "you", false],
  ])("%s → %s (root %s)", (path, tab, root) => {
    expect(tabFor(path)).toBe(tab);
    expect(isTabRoot(path)).toBe(root);
  });
});
