import { describe, expect, it } from "vitest";
import { ApiError } from "@datrope/core";
import { formatBytes, formatDuration, classifyPollError, nextPoll, sparklinePoints, stageLabel, updatesAvailable, type PollResult } from "./system";

describe("formatBytes", () => {
  it("picks a unit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024 ** 3)).toBe("20 GB");
    expect(formatBytes(3.25 * 1024 ** 4)).toBe("3.3 TB");
  });
});

describe("formatDuration", () => {
  it("shows the two largest units", () => {
    expect(formatDuration(59)).toBe("0m");
    expect(formatDuration(3 * 60)).toBe("3m");
    expect(formatDuration(4 * 3600 + 12 * 60)).toBe("4h 12m");
    expect(formatDuration(3 * 86400 + 4 * 3600 + 5)).toBe("3d 4h");
  });
});

describe("sparklinePoints", () => {
  it("scales to the box, newest on the right", () => {
    expect(sparklinePoints([0, 50, 100], 100, 100, 20)).toBe("0,20 50,10 100,0");
  });
  it("is empty without two points and clamps above max", () => {
    expect(sparklinePoints([5], 100, 100, 20)).toBe("");
    expect(sparklinePoints([0, 200], 100, 10, 10)).toBe("0,10 10,0");
  });
});

describe("updatesAvailable", () => {
  const base = { server: { configured: true }, ytdlp: { available: true, installed: "1", latest: "1", pinned: false } };
  it("counts the server and yt-dlp", () => {
    expect(updatesAvailable(base as never)).toBe(0);
    expect(updatesAvailable({ ...base, server: { configured: true, status: { behind: 3 } } } as never)).toBe(1);
    expect(updatesAvailable({ ...base, ytdlp: { ...base.ytdlp, latest: "2" } } as never)).toBe(1);
  });
  it("counts a server whose containers run an older commit than the checkout", () => {
    const server = (deployed: string) => ({ configured: true, status: { behind: 0, current: "c", deployed } });
    expect(updatesAvailable({ ...base, server: server("a") } as never)).toBe(1);
    expect(updatesAvailable({ ...base, server: server("c") } as never)).toBe(0);
    expect(updatesAvailable({ ...base, server: server("") } as never)).toBe(0);
  });
  it("ignores a pinned or unknown yt-dlp", () => {
    expect(updatesAvailable({ ...base, ytdlp: { ...base.ytdlp, latest: "2", pinned: true } } as never)).toBe(0);
    expect(updatesAvailable({ ...base, ytdlp: { ...base.ytdlp, latest: "" } } as never)).toBe(0);
  });
});

describe("nextPoll", () => {
  const start = { phase: "running" as const, lines: ["a"], next: 1 };
  const log = (status: string, lines: string[], next: number) => ({ log: { job: { id: "1", status, started_at: "" }, lines, next } }) as never;

  it("appends new lines and follows the status", () => {
    expect(nextPoll(start, log("running", ["b"], 2))).toEqual({ phase: "running", lines: ["a", "b"], next: 2 });
    expect(nextPoll(start, log("succeeded", [], 1)).phase).toBe("succeeded");
    expect(nextPoll(start, log("failed", ["!! boom"], 2)).phase).toBe("failed");
  });

  it("treats a transient poll failure as the server restarting, not as a failed update", () => {
    const r = nextPoll(start, { transient: true });
    expect(r).toEqual({ phase: "restarting", lines: ["a"], next: 1 });
    expect(nextPoll(r, log("running", ["c"], 2))).toEqual({ phase: "running", lines: ["a", "c"], next: 2 });
  });

  it("fails with the message on a terminal error", () => {
    expect(nextPoll(start, { error: "gone" })).toEqual({ phase: "failed", lines: ["a"], next: 1, message: "gone" });
  });

  it("stays finished", () => {
    expect(nextPoll({ ...start, phase: "succeeded" }, { transient: true }).phase).toBe("succeeded");
  });
});

describe("classifyPollError", () => {
  it("keeps waiting on network errors and an unreachable updater", () => {
    expect(classifyPollError(new TypeError("Failed to fetch"))).toEqual({ transient: true });
    expect(classifyPollError(new ApiError(503, "UPDATER_UNREACHABLE", "x"))).toEqual({ transient: true });
    expect(classifyPollError(new ApiError(502, "UNKNOWN", "x"))).toEqual({ transient: true });
  });

  it("stops on everything else", () => {
    expect(classifyPollError(new ApiError(404, "NOT_FOUND", "x"))).toEqual({ error: "The update log is no longer available." });
    expect(classifyPollError(new ApiError(503, "UPDATER_NOT_CONFIGURED", "Updater is off"))).toEqual({ error: "Updater is off" });
    expect(classifyPollError(new ApiError(403, "FORBIDDEN", "Not allowed"))).toEqual({ error: "Not allowed" });
    expect(classifyPollError(new ApiError(500, "INTERNAL", "Boom"))).toEqual({ error: "Boom" });
  });
});

describe("stageLabel", () => {
  it("names the running step", () => {
    expect(stageLabel({ phase: "running", lines: [], next: 0, stage: 4, stages: 8, stageTitle: "start new server" }))
      .toEqual({ label: "Step 4 of 8 — Start new server", percent: 37.5 });
  });
  it("is full when done", () => {
    expect(stageLabel({ phase: "succeeded", lines: [], next: 0, stage: 8, stages: 8, stageTitle: "restart the updater" })?.percent).toBe(100);
  });
  it("is null before the first poll", () => {
    expect(stageLabel({ phase: "running", lines: [], next: 0 })).toBeNull();
  });
});

describe("nextPoll stages", () => {
  it("copies the stage from the job", () => {
    const v = nextPoll({ phase: "running", lines: [], next: 0 }, {
      log: { job: { id: "1", status: "running", started_at: "", stage: 2, stages: 8, stage_title: "build" }, lines: [], next: 0 },
    } as PollResult);
    expect(v.stage).toBe(2);
    expect(v.stages).toBe(8);
    expect(v.stageTitle).toBe("build");
  });
});
