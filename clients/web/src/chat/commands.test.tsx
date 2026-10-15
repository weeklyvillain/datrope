import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMANDS, availableCommands, commandPending, flip, isCommand, parseCommand, randomInt, roll, runCommand, type CommandContext } from "./commands";
import { MarkdownView } from "./Markdown";

// The session module creates the client from window.location, which Node lacks; MarkdownView needs neither.
vi.mock("@/session", () => ({ client: {}, useApp: () => undefined }));

const opts = { custom: new Map(), shortcodes: new Map(), users: new Map(), meId: "1" };
/** The text a message shows once its Markdown is rendered. */
const rendered = (md: string) => renderToStaticMarkup(<MarkdownView text={md} options={opts} />).replace(/<[^>]+>/g, "");

const ctx = (): CommandContext & { statuses: string[]; reminders: { due_at: string; note: string }[]; panels: number } => {
  const statuses: string[] = [];
  const reminders: { due_at: string; note: string }[] = [];
  const c = {
    statuses, reminders, panels: 0, gifsEnabled: true, canAttach: true,
    setStatus: async (t: string) => { statuses.push(t); },
    setReminder: async (b: { due_at: string; note: string }) => { reminders.push(b); },
    openReminders: () => { c.panels++; },
  };
  return c;
};
const send = async (text: string) => runCommand(text, ctx());

describe("parseCommand", () => {
  it.each([
    ["/shrug", { name: "shrug", args: "" }],
    ["/shrug hi there", { name: "shrug", args: "hi there" }],
    ["/SHRUG  hi ", { name: "shrug", args: "hi" }],
    ["/me waves\nagain", { name: "me", args: "waves\nagain" }],
  ])("%j", (text, want) => {
    expect(parseCommand(text)).toEqual(want);
  });

  it.each(["/", "/ hi", "/usr/bin/env", "/123", "hello /shrug", "//shrug", ""])("%j is not a command", (text) => {
    expect(parseCommand(text)).toBeNull();
  });
});

describe("runCommand", () => {
  it("passes plain text and non-commands through", async () => {
    expect(await send("hello")).toBeNull();
    expect(await send("/usr/bin/env")).toBeNull();
    expect(await send("/")).toBeNull();
    expect(isCommand("hello")).toBe(false);
    expect(isCommand("/usr/bin/env")).toBe(false);
  });

  it("sends // as a literal slash", async () => {
    expect(isCommand("//shrug")).toBe(true);
    expect(await send("//shrug")).toEqual({ send: "/shrug" });
  });

  it("rejects an unknown command", async () => {
    expect(isCommand("/nope")).toBe(true);
    expect(await send("/nope")).toEqual({ error: "Unknown command /nope. Start with // to send it as text." });
  });

  it("refuses output over the 4000-character message limit", async () => {
    expect(await send(`/shrug ${"a".repeat(3999)}`)).toEqual({ error: "That message would be over 4000 characters" });
  });

  it.each([
    ["/shrug", "¯\\_(ツ)_/¯"],
    ["/shrug ok", "ok ¯\\_(ツ)_/¯"],
    ["/tableflip", "(╯°□°)╯︵ ┻━┻"],
    ["/tableflip argh", "argh (╯°□°)╯︵ ┻━┻"],
    ["/unflip", "┬─┬ノ( º _ ºノ)"],
    ["/unflip sorry", "sorry ┬─┬ノ( º _ ºノ)"],
    ["/me waves", "waves"],
  ])("%s renders as %j", async (text, want) => {
    const result = await send(text);
    expect(result).toHaveProperty("send");
    expect(rendered((result as { send: string }).send)).toBe(want);
  });

  it("/me is italic and /spoiler hides its text", async () => {
    expect(await send("/me waves")).toEqual({ send: "_waves_" });
    expect(await send("/spoiler he dies")).toEqual({ send: "||he dies||" });
  });

  it.each(["/me", "/spoiler"])("%s needs text", async (text) => {
    expect(await send(text)).toEqual({ error: `Usage: ${text} <${text === "/me" ? "action" : "text"}>` });
  });

  it("/status sets and clears the custom status", async () => {
    const c = ctx();
    expect(await runCommand("/status  gaming ", c)).toEqual({ done: true });
    expect(await runCommand("/status", c)).toEqual({ done: true });
    expect(c.statuses).toEqual(["gaming", ""]);
    expect(await runCommand(`/status ${"x".repeat(81)}`, c)).toEqual({ error: "A status can be at most 80 characters" });
    expect(c.statuses).toHaveLength(2);
  });

  it("/roll and /flip use real randomness", async () => {
    expect(await send("/flip")).toMatchObject({ send: expect.stringMatching(/^🪙 (Heads|Tails)$/) });
    expect(await send("/roll")).toMatchObject({ send: expect.stringMatching(/^🎲 1d20: \*\*([1-9]|1\d|20)\*\*$/) });
  });

  it("/wheel shows the options as typed, even without its card", async () => {
    const r = await send("/wheel *bold*, a|b, <@1>");
    expect(r).toMatchObject({ send: expect.stringMatching(/^🎡 Spun the wheel: /) });
    expect(rendered((r as { send: string }).send)).toMatch(/^🎡 Spun the wheel: \*bold\*, a\|b, &lt;@1&gt; → (\*bold\*|a\|b|&lt;@1&gt;)$/);
  });

  it("lists every command once, in lower case", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toEqual(["shrug", "tableflip", "unflip", "me", "spoiler", "roll", "flip", "wheel", "status", "remind", "reminders", "gif", "poll",
      "play", "skip", "pause", "resume", "stop"]);
  });

  it("controls the music bot only in a voice channel's chat", async () => {
    expect(availableCommands(ctx()).map((c) => c.name)).not.toContain("play");
    const calls: string[] = [];
    const voice: CommandContext = { ...ctx(), music: { queue: async (q) => calls.push(`queue ${q}`), control: async (a) => calls.push(a) } };
    expect(availableCommands(voice).map((c) => c.name)).toEqual(expect.arrayContaining(["play", "skip", "pause", "resume", "stop"]));
    expect(await runCommand("/play never gonna", voice)).toEqual({ done: true });
    expect(await runCommand("/play", voice)).toEqual({ error: "Usage: /play <link or search>" });
    expect(commandPending("/play never gonna", voice)).toBe("Looking up “never gonna”…");
    expect(commandPending("/play", voice)).toBeUndefined();
    expect(commandPending("/skip", voice)).toBeUndefined();
    expect(await runCommand("/skip", voice)).toEqual({ done: true });
    expect(calls).toEqual(["queue never gonna", "skip"]);
  });
});

describe("roll", () => {
  const fixed = (...values: number[]) => () => values.shift()!; // rand returns 0-based values

  it.each([
    ["", [13], "🎲 1d20: **14**"],
    ["d6", [2], "🎲 1d6: **3**"],
    ["2d6", [2, 4], "🎲 2d6: 3 + 5 = **8**"],
    ["2D6", [0, 0], "🎲 2d6: 1 + 1 = **2**"],
    ["20d1000", Array(20).fill(999), `🎲 20d1000: ${Array(20).fill(1000).join(" + ")} = **20000**`],
  ])("%j", (spec, values, want) => {
    expect(roll(spec, fixed(...values))).toEqual({ send: want });
  });

  it.each(["21d6", "0d6", "1d1", "1d1001", "99d99999", "abc", "2d", "-1d6"])("%j is refused", (spec) => {
    expect(roll(spec, fixed(0))).toHaveProperty("error");
  });
});

describe("flip and randomInt", () => {
  it("flips by the random value", () => {
    expect(flip(() => 0)).toEqual({ send: "🪙 Heads" });
    expect(flip(() => 1)).toEqual({ send: "🪙 Tails" });
  });

  it("stays in range", () => {
    for (let i = 0; i < 1000; i++) {
      const n = randomInt(6);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(6);
    }
  });
});

describe("/poll", () => {
  it("opens the poll dialog, prefilled with the question", async () => {
    expect(await send("/poll")).toEqual({ open: "poll", query: "" });
    expect(await send("/poll  Pizza or tacos? ")).toEqual({ open: "poll", query: "Pizza or tacos?" });
  });
});

describe("/gif", () => {
  it("opens the GIF picker with the search text", async () => {
    expect(await send("/gif")).toEqual({ open: "gif", query: "" });
    expect(await send("/GIF  happy cat ")).toEqual({ open: "gif", query: "happy cat" });
  });

  it("does not exist without a Klipy key", async () => {
    const off = { ...ctx(), gifsEnabled: false };
    expect(await runCommand("/gif cat", off)).toEqual({ error: "Unknown command /gif. Start with // to send it as text." });
    expect(availableCommands(off).map((c) => c.name)).not.toContain("gif");
    expect(availableCommands(ctx()).map((c) => c.name)).toContain("gif");
  });

  it("does not exist without the AttachFiles permission", async () => {
    const off = { ...ctx(), canAttach: false };
    expect(await runCommand("/gif cat", off)).toEqual({ error: "Unknown command /gif. Start with // to send it as text." });
    expect(availableCommands(off).map((c) => c.name)).not.toContain("gif");
  });
});

describe("/remind", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 14, 14, 2)); });
  afterEach(() => vi.useRealTimers());

  it("sets a reminder from the compact syntax", async () => {
    const c = ctx();
    expect(await runCommand("/remind tomorrow 9 call the dentist", c)).toEqual({ done: true });
    expect(c.reminders).toEqual([{ due_at: new Date(2026, 9, 15, 9).toISOString(), note: "call the dentist" }]);
  });
  it("opens the dialog when bare", async () =>
    expect(await runCommand("/remind", ctx())).toEqual({ open: "reminder" }));
  it.each(["/remind soon stuff", "/remind 20m"])("explains usage for %j", async (text) =>
    expect(await runCommand(text, ctx())).toEqual({ error: "Usage: /remind <20m|2h|14:30|tomorrow 9|fri 13:00> <text>" }));
  it("/reminders opens the panel", async () => {
    const c = ctx();
    expect(await runCommand("/reminders", c)).toEqual({ done: true });
    expect(c.panels).toBe(1);
  });
  it("/reminders is unavailable without a panel", () =>
    expect(availableCommands({ ...ctx(), openReminders: undefined }).map((x) => x.name)).not.toContain("reminders"));
});
