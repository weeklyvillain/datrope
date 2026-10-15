import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SystemStats } from "@datrope/core";
import { SystemView, restartWarning } from "./System";

vi.mock("@/session", () => ({ client: {} }));

const sample = {
  at: "2026-10-11T10:00:00Z", cpu_percent: 12.5, mem_used: 2 * 1024 ** 3, mem_total: 8 * 1024 ** 3,
  disk_used: 10 * 1024 ** 3, disk_total: 100 * 1024 ** 3, connections: 4, in_voice: 2,
};
const stats = (over: Partial<SystemStats> = {}): SystemStats => ({
  host: { latest: sample, series: [sample, sample], host_uptime_seconds: 90000, process_uptime_seconds: 600, database_bytes: 1024 ** 2, files_bytes: 5 * 1024 ** 3 },
  containers: [{ service: "server", name: "datrope-server-1", state: "running", status: "Up 2 hours", cpu_percent: 3, mem_bytes: 100 * 1024 ** 2, mem_limit: 0 }],
  updater_configured: true,
  ...over,
});

describe("SystemView", () => {
  it("shows host figures and containers", () => {
    const html = renderToStaticMarkup(<SystemView stats={stats()} onRestart={() => {}} />);
    expect(html).toContain("13%"); // CPU, rounded
    expect(html).toContain("2 GB of 8 GB");
    expect(html).toContain("5 GB"); // uploaded files
    expect(html).toContain("1d 1h"); // host uptime
    expect(html).toContain("datrope-server-1");
    expect(html).toContain('aria-label="Restart server"');
  });

  it("explains a missing updater instead of the table", () => {
    const html = renderToStaticMarkup(<SystemView stats={stats({ updater_configured: false, containers: [] })} onRestart={() => {}} />);
    expect(html).toContain("DATROPE_UPDATER_TOKEN");
    expect(html).not.toContain("Restart server");
  });

  it("shows why the updater did not answer", () => {
    const html = renderToStaticMarkup(<SystemView stats={stats({ updater_error: "updater unreachable", containers: [] })} onRestart={() => {}} />);
    expect(html).toContain("updater unreachable");
  });
});

describe("restartWarning", () => {
  it("warns that restarting a server slot disconnects everyone", () => {
    expect(restartWarning("server-blue")).toContain("Everyone is disconnected");
    expect(restartWarning("server-green")).toContain("Everyone is disconnected");
    expect(restartWarning("imgproxy")).toBe("The imgproxy container stops and starts again.");
  });
});
