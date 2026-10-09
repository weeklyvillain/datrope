import { describe, expect, it } from "vitest";
import { claimMessage, notificationBody, notificationTitle, shouldNotify, type NotifyInput } from "./notify";

const base: NotifyInput = {
  message: { author: { id: "2" }, mentions: [], channel_id: "100" },
  meId: "1",
  isDM: false,
  prefs: { enabled: true, level: "mentions" },
  permission: "granted",
  hidden: true,
  openChannelIds: ["100"],
};

describe("shouldNotify", () => {
  it("follows the level", () => {
    expect(shouldNotify(base)).toBe(false); // no mention
    expect(shouldNotify({ ...base, message: { ...base.message, mentions: ["1"] } })).toBe(true);
    expect(shouldNotify({ ...base, isDM: true })).toBe(true); // DMs count as mentions
    expect(shouldNotify({ ...base, prefs: { enabled: true, level: "all" } })).toBe(true);
    expect(shouldNotify({ ...base, isDM: true, prefs: { enabled: true, level: "nothing" } })).toBe(false);
  });

  it("needs the switch, the permission and someone else", () => {
    const dm = { ...base, isDM: true };
    expect(shouldNotify({ ...dm, prefs: { enabled: false, level: "all" } })).toBe(false);
    expect(shouldNotify({ ...dm, permission: "denied" })).toBe(false);
    expect(shouldNotify({ ...dm, permission: "unsupported" })).toBe(false);
    expect(shouldNotify({ ...dm, message: { ...dm.message, author: { id: "1" } } })).toBe(false);
    expect(shouldNotify({ ...dm, meId: undefined })).toBe(false);
  });

  it("stays quiet in the conversation you are looking at", () => {
    const dm = { ...base, isDM: true };
    expect(shouldNotify({ ...dm, hidden: false })).toBe(false);
    expect(shouldNotify({ ...dm, hidden: false, openChannelIds: ["200"] })).toBe(true);
    expect(shouldNotify({ ...dm, hidden: true, openChannelIds: ["100"] })).toBe(true);
  });
});

describe("notification text", () => {
  it("says who and where", () => {
    expect(notificationTitle("Dan", { type: "text", name: "games" })).toBe("Dan in #games");
    expect(notificationTitle("Bob", { type: "dm", name: "" })).toBe("Bob (direct message)");
    expect(notificationTitle("Carol", { type: "thread", name: "Saturday plan", parent_name: "games" })).toBe("Carol in #games");
    expect(notificationTitle("Carol", { type: "thread", name: "", parent_name: "" })).toBe("Carol in a thread");
  });

  it("is plain text up to 120 characters", () => {
    expect(notificationBody("**Saturday:** board games? ||it's a surprise||", 0)).toBe("Saturday: board games? (spoiler)");
    expect(notificationBody("see [the rules](https://x.com) and `code`", 0)).toBe("see the rules and code");
    expect(notificationBody("> quoted\nline", 0)).toBe("quoted line");
    const long = notificationBody("a".repeat(200), 0);
    expect(Array.from(long)).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
    expect(notificationBody("look ![cat](https://x.com/c.png)", 0)).toBe("look cat");
    expect(notificationBody("# Plan\n- one\n* two\nsome *italic* and _more_ text", 0)).toBe("Plan one two some italic and more text");
    expect(notificationBody("snake_case_name stays, 2 * 3 too", 0)).toBe("snake_case_name stays, 2 * 3 too");
    expect(notificationBody("", 1)).toBe("Sent a file");
    expect(notificationBody("", 3)).toBe("Sent 3 files");
  });
});

describe("claimMessage", () => {
  it("lets one tab claim a message", () => {
    expect(claimMessage([], "5")).toEqual(["5"]);
    expect(claimMessage(["5"], "5")).toBeNull();
  });

  it("keeps only the 200 most recent", () => {
    const many = Array.from({ length: 200 }, (_, i) => String(i));
    const next = claimMessage(many, "x");
    expect(next).toHaveLength(200);
    expect(next?.[0]).toBe("1");
    expect(next?.at(-1)).toBe("x");
  });
});
