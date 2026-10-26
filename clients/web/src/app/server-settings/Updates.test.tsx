// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SystemUpdates } from "@datrope/core";
import { UpdatesView } from "./Updates";

vi.mock("@/session", () => ({ client: {}, errorText: String }));

const checked_at = "2026-10-11T12:00:00Z";
const ytdlp = { available: true, installed: "2026.01.01", latest: "2026.10.01", pinned: false, checked_at };
const updates = (over: Partial<SystemUpdates> = {}): SystemUpdates => ({
  server: {
    configured: true,
    status: {
      current: "aaaaaaa1", latest: "ccccccc3", behind: 2, checked_at, commits: [
        { sha: "ccccccc3", subject: "Fix voice", author: "Filip", date: "2026-10-11T10:00:00Z" },
        { sha: "bbbbbbb2", subject: "Add polls", author: "Filip", date: "2026-10-10T10:00:00Z" },
      ],
    },
  },
  ytdlp,
  ...over,
});
const noop = () => {};
const props = { busy: false, job: undefined, onCheck: noop, onUpdateServer: noop, onUpdateYtDlp: noop };

describe("UpdatesView", () => {
  it("lists the commits behind and offers the updates", () => {
    const html = renderToStaticMarkup(<UpdatesView {...props} updates={updates()} />);
    expect(html).toContain("2 commits behind");
    expect(html).toContain("Fix voice");
    expect(html).toContain("Update server");
    expect(html).toContain("2026.01.01");
    expect(html).toContain("Update yt-dlp");
  });

  it("says when everything is current", () => {
    const html = renderToStaticMarkup(<UpdatesView {...props} updates={updates({
      server: { configured: true, status: { current: "a", latest: "a", behind: 0, commits: [], checked_at } },
      ytdlp: { ...ytdlp, latest: "2026.01.01" },
    })} />);
    expect(html).toContain("Up to date");
    expect(html).not.toContain("Update server");
    expect(html).not.toContain("Update yt-dlp");
  });

  it("explains a missing updater and a pinned yt-dlp", () => {
    const html = renderToStaticMarkup(<UpdatesView {...props} updates={updates({ server: { configured: false }, ytdlp: { ...ytdlp, pinned: true } })} />);
    expect(html).toContain("DATROPE_UPDATER_TOKEN");
    expect(html).toContain("managed by DATROPE_YTDLP");
    expect(html).not.toContain("Update yt-dlp");
  });

  it("shows the log of a running job and hides the update button", () => {
    const html = renderToStaticMarkup(<UpdatesView {...props} updates={updates()} job={{ phase: "restarting", lines: ["==> docker compose up"], next: 1 }} />);
    expect(html).toContain("==&gt; docker compose up");
    expect(html).toContain("Restarting");
    expect(html).not.toContain("Update server");
  });

  it("says not checked yet instead of up to date", () => {
    const html = renderToStaticMarkup(<UpdatesView {...props} updates={updates({
      server: { configured: true, status: { current: "", latest: "", behind: 0, commits: [] } },
      ytdlp: { available: true, installed: "", latest: "", pinned: false },
    })} />);
    expect(html.match(/Not checked yet\./g)).toHaveLength(2);
    expect(html).not.toContain("Up to date");
    expect(html).not.toContain("Running");
    expect(html).not.toContain("Installed");
  });

  it("shows only the error when the check failed", () => {
    const html = renderToStaticMarkup(<UpdatesView {...props} updates={updates({
      server: { configured: true, status: { current: "", latest: "", behind: 0, commits: [], checked_at, error: "git fetch: exit status 128" } },
    })} />);
    expect(html).toContain("git fetch: exit status 128");
    expect(html).not.toContain("Up to date");
    expect(html).not.toContain("Running");
  });

  it("offers a rebuild when the containers run an older commit than the checkout", () => {
    const html = renderToStaticMarkup(<UpdatesView {...props} updates={updates({
      server: { configured: true, status: { current: "ccccccc3", latest: "ccccccc3", behind: 0, commits: [], checked_at, deployed: "aaaaaaa1" } },
    })} />);
    expect(html).toContain("Running <code>aaaaaaa</code>");
    expect(html).toContain("Checkout is at <code>ccccccc</code>, containers run <code>aaaaaaa</code>");
    expect(html).toContain("Rebuild and restart");
    expect(html).not.toContain("Update server");
    expect(html).not.toContain("Up to date");
  });

  it("runs the deployed commit and stays up to date when it matches", () => {
    const html = renderToStaticMarkup(<UpdatesView {...props} updates={updates({
      server: { configured: true, status: { current: "ccccccc3", latest: "ccccccc3", behind: 0, commits: [], checked_at, deployed: "ccccccc3" } },
    })} />);
    expect(html).toContain("Running <code>ccccccc</code>");
    expect(html).toContain("Up to date");
    expect(html).not.toContain("Rebuild and restart");
  });

  it("names the new commit after an update and offers a reload", () => {
    const html = renderToStaticMarkup(<UpdatesView {...props} updates={updates()} job={{ phase: "succeeded", lines: [], next: 0, sha: "ccccccc3" }} />);
    expect(html).toContain("Updated to ccccccc");
    expect(html).toContain("Reload the page to load the new version.");
    expect(html).toContain(">Reload</button>");
  });

  // Chrome's scrollIntoView returns a Promise; React must not take it for the effect's cleanup.
  it("keeps following the log when scrollIntoView returns a promise", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => Promise.resolve() as never);
    const host = document.createElement("div");
    const root = createRoot(host);
    const render = (lines: string[]) => root.render(<UpdatesView {...props} updates={updates()} job={{ phase: "running", lines, next: lines.length }} />);
    await act(async () => render(["==> git pull"]));
    await act(async () => render(["==> git pull", "==> docker compose build"]));
    expect(host.textContent).toContain("==> docker compose build");
    expect(scroll).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
    scroll.mockRestore();
  });
});
