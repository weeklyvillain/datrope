// Slash commands typed at the start of the composer. Pure: the composer passes
// side effects in through CommandContext.

import { wheel } from "./wheel";

export type ModalKind = "gif" | "poll";
export type CommandContext = {
  gifsEnabled: boolean; // instance info: a Klipy key is set
  canAttach: boolean; // the member holds AttachFiles, which posting a GIF needs
  setStatus: (text: string) => Promise<unknown>;
  /** Set in a voice channel's chat: controls its music bot. */
  music?: {
    queue: (query: string) => Promise<unknown>;
    control: (action: "pause" | "resume" | "skip" | "stop") => Promise<unknown>;
  };
};
export type CommandResult =
  | { send: string }
  | { open: ModalKind; query?: string } // the composer opens that modal
  | { done: true }
  | { error: string };
export type Command = {
  name: string;
  args?: string; // hint shown in the picker, e.g. "[NdM]"
  description: string;
  /** Hidden from the picker and treated as unknown when this returns false; always available when absent. */
  available?: (ctx: CommandContext) => boolean;
  /** What the composer shows while a slow run is in flight. */
  pending?: (args: string) => string | undefined;
  run: (args: string, ctx: CommandContext) => CommandResult | Promise<CommandResult>;
};

const MAX_LENGTH = 4000; // the server's limit per message
const MAX_STATUS = 80; // the server's custom_status limit

// Markdown-escaped so the backslash survives rendering: ¯\_(ツ)_/¯
const SHRUG = String.raw`¯\\\_(ツ)\_/¯`;
const TABLEFLIP = "(╯°□°)╯︵ ┻━┻";
const UNFLIP = "┬─┬ノ( º _ ºノ)";

const withFace = (args: string, face: string): CommandResult => ({ send: args ? `${args} ${face}` : face });
const needs = (name: string, what: string, wrap: (s: string) => string) =>
  (args: string): CommandResult => (args ? { send: wrap(args) } : { error: `Usage: /${name} <${what}>` });

export const COMMANDS: Command[] = [
  { name: "shrug", args: "[text]", description: "Appends ¯\\_(ツ)_/¯", run: (a) => withFace(a, SHRUG) },
  { name: "tableflip", args: "[text]", description: `Appends ${TABLEFLIP}`, run: (a) => withFace(a, TABLEFLIP) },
  { name: "unflip", args: "[text]", description: `Appends ${UNFLIP}`, run: (a) => withFace(a, UNFLIP) },
  { name: "me", args: "<action>", description: "Says what you're doing, in italics", run: needs("me", "action", (s) => `_${s}_`) },
  { name: "spoiler", args: "<text>", description: "Hides the text until clicked", run: needs("spoiler", "text", (s) => `||${s}||`) },
  { name: "roll", args: "[NdM]", description: "Rolls dice, 1d20 by default", run: (a) => roll(a) },
  { name: "flip", description: "Flips a coin", run: () => flip() },
  { name: "wheel", args: "<option, option, …>", description: "Spins a wheel and picks one option", run: (a) => wheel(a, randomInt) },
  {
    name: "status", args: "[text]", description: "Sets your custom status; empty clears it",
    run: async (a, ctx) => {
      if (a.length > MAX_STATUS) return { error: `A status can be at most ${MAX_STATUS} characters` };
      await ctx.setStatus(a);
      return { done: true };
    },
  },
  {
    name: "gif", args: "[search]", description: "Finds a GIF to post",
    available: (ctx) => ctx.gifsEnabled && ctx.canAttach,
    run: (a) => ({ open: "gif", query: a }),
  },
  { name: "poll", args: "[question]", description: "Creates a poll", run: (a) => ({ open: "poll", query: a }) },
  {
    name: "play", args: "<song>", description: "Queues a YouTube link or search on the music bot",
    available: (ctx) => !!ctx.music,
    pending: (a) => (a ? `Looking up “${a}”…` : undefined),
    run: async (a, ctx) => {
      if (!a) return { error: "Usage: /play <link or search>" };
      await ctx.music!.queue(a);
      return { done: true };
    },
  },
  ...(["skip", "pause", "resume", "stop"] as const).map((action): Command => ({
    name: action, description: { skip: "Skips the current song", pause: "Pauses the music", resume: "Resumes the music", stop: "Stops the music and clears the queue" }[action],
    available: (ctx) => !!ctx.music,
    run: async (_a, ctx) => {
      await ctx.music!.control(action);
      return { done: true };
    },
  })),
];

/** The commands that apply in this context, in registry order. */
export function availableCommands(ctx: CommandContext): Command[] {
  return COMMANDS.filter((c) => c.available?.(ctx) ?? true);
}

const PATTERN = /^\/([A-Za-z]+)(?:\s+([\s\S]*))?$/;

/** The command name (lower case) and trimmed arguments, or null when `text` is not a command. */
export function parseCommand(text: string): { name: string; args: string } | null {
  const m = PATTERN.exec(text.trim());
  return m ? { name: m[1]!.toLowerCase(), args: (m[2] ?? "").trim() } : null;
}

/** True when `text` goes through runCommand: a command, or the // escape. */
export function isCommand(text: string): boolean {
  const t = text.trim();
  return t.startsWith("//") || parseCommand(t) !== null;
}

/** The in-flight text for `text` when it is a command that shows one. */
export function commandPending(text: string, ctx: CommandContext): string | undefined {
  const parsed = parseCommand(text);
  if (!parsed) return undefined;
  return availableCommands(ctx).find((c) => c.name === parsed.name)?.pending?.(parsed.args);
}

/** Runs `text` if it is a command. null: not a command, send it as typed. */
export async function runCommand(text: string, ctx: CommandContext): Promise<CommandResult | null> {
  const t = text.trim();
  if (t.startsWith("//")) return { send: t.slice(1) };
  const parsed = parseCommand(t);
  if (!parsed) return null;
  const cmd = availableCommands(ctx).find((c) => c.name === parsed.name);
  if (!cmd) return { error: `Unknown command /${parsed.name}. Start with // to send it as text.` };
  const result = await cmd.run(parsed.args, ctx);
  if ("send" in result && result.send.length > MAX_LENGTH) return { error: `That message would be over ${MAX_LENGTH} characters` };
  return result;
}

const DICE = /^(\d{1,3})?d(\d{1,5})$/i;

/** `NdM` dice (default 1d20). `rand(max)` returns an integer in [0, max). */
export function roll(spec: string, rand: (max: number) => number = randomInt): CommandResult {
  const m = DICE.exec(spec || "1d20");
  if (!m) return { error: "Usage: /roll [NdM], for example /roll 2d6" };
  const n = Number(m[1] ?? 1);
  const sides = Number(m[2]);
  if (n < 1 || n > 20 || sides < 2 || sides > 1000) return { error: "You can roll 1–20 dice with 2–1000 sides" };
  const rolls = Array.from({ length: n }, () => rand(sides) + 1);
  const total = rolls.reduce((a, b) => a + b, 0);
  return { send: `🎲 ${n}d${sides}: ${n === 1 ? "" : `${rolls.join(" + ")} = `}**${total}**` };
}

export function flip(rand: (max: number) => number = randomInt): CommandResult {
  return { send: rand(2) === 0 ? "🪙 Heads" : "🪙 Tails" };
}

/** A uniform integer in [0, max), without modulo bias. */
export function randomInt(max: number): number {
  const limit = Math.floor(2 ** 32 / max) * max;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0]! >= limit);
  return buf[0]! % max;
}
