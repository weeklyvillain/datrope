# Slash Commands (piece 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typing `/` at the start of the composer opens a command picker. Eight client-side commands work: `/shrug`, `/tableflip`, `/unflip`, `/me`, `/spoiler`, `/roll`, `/flip`, `/status`.

**Architecture:** Client only, no server changes.
- `src/chat/autocomplete.ts` learns a third trigger kind, `"command"`.
- New `src/chat/commands.ts` holds the registry plus pure parsing and running. It has no React and no session import; the composer passes side effects in through `CommandContext`.
- `AutocompleteList.tsx` lists commands for the new trigger.
- `Composer.tsx` runs a command on submit instead of sending the raw text.

**Tech Stack:** React 18, TypeScript, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-10-commands-gifs-polls-webhooks-design.md` §1

## Global Constraints

- **Never commit** (AGENTS.md §5). Each task ends by staging its files with `git add`; the user commits.
- The Write/Edit tools are blocked on project files on this machine. Write in the session scratchpad and `cp`, or use a Bash heredoc. Heredocs break on some content; the scratchpad + `cp` route is the reliable one.
- `git` needs `-c safe.directory='*'` in this worktree (exFAT).
- Run unit tests and the typecheck from `clients/web`: `pnpm test` and `pnpm typecheck`.
- Colours only from tokens (`bg-muted`, `text-muted-foreground`, ...). Dark-only: no `dark:` classes.
- Keep existing accessible names. The composer box stays `aria-label="Message"`; the existing listboxes stay "Member suggestions" / "Emoji suggestions".
- The server's message limit is 4000 characters.
- Scope note: the spec's `{ open: "gif" | "poll" }` result and `available(ctx)` belong to pieces 2 and 3. They are **not** added here, because no command in this piece uses them.

## Review Focus

1. Text that starts with `/` but is not a command (`/usr/bin/env`, `/ hi`, a lone `/`) must be sent unchanged, not rejected as an unknown command. Pinned in Task 2 (`parseCommand` tests).
2. An unknown name (`/nope`) must show an error, keep the text in the box and send nothing. Pinned in Task 2 (`runCommand` test) and Task 3 (e2e).
3. Markdown escaping: `/shrug` must *render* as `¯\_(ツ)_/¯`. A naive `¯\_(ツ)_/¯` string loses the backslash, because `\_` is a Markdown escape. Pinned in Task 2 by rendering through `MarkdownView`.
4. A command's output longer than 4000 characters (`/shrug` on a 3999-character message) must be refused with an error, not sent and lost. Pinned in Task 2 (`runCommand` test).
5. Case and whitespace: `/SHRUG  hi ` and multi-line arguments (`/me waves\nagain`) must work, and the name is case-insensitive. Pinned in Task 2 (`parseCommand` tests).

---

### Task 1: The `command` trigger

**Files:**
- Modify: `clients/web/src/chat/autocomplete.ts`
- Test: `clients/web/src/chat/autocomplete.test.ts`

**Interfaces:**
- Produces: `Trigger = { kind: "emoji" | "mention" | "command"; query: string; start: number }`. For a command, `start` is always `0` and `query` is the name typed so far (possibly `""`).

- [ ] **Step 1: Write the failing tests**

Add these rows to the existing `it.each` table in `clients/web/src/chat/autocomplete.test.ts`, after the `"`@bob"` row:

```ts
    ["/", 1, { kind: "command", query: "", start: 0 }],
    ["/shr", 4, { kind: "command", query: "shr", start: 0 }],
    ["/shrug hi", 9, null], // past the name: the picker closes
    ["/shrug hi", 3, { kind: "command", query: "sh", start: 0 }], // caret back inside the name
    ["hi /shr", 7, null], // only at the very start of the message
    ["a\n/shr", 6, null], // not at the start of a later line either
    ["//", 2, null], // the // escape
    ["/usr/bin", 8, null],
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- autocomplete` (from `clients/web`)
Expected: FAIL. The `"/"`, `"/shr"` and `"/shrug hi", 3` rows get `null` instead of a command trigger.

- [ ] **Step 3: Implement**

In `clients/web/src/chat/autocomplete.ts`, replace the `Trigger` type and add the command check at the top of `findTrigger`:

```ts
export type Trigger = { kind: "emoji" | "mention" | "command"; query: string; start: number };

const MENTION = /(?:^|[\s(])@([A-Za-z0-9_.-]{2,})$/;
const EMOJI = /(?:^|\s):([A-Za-z0-9_+-]{2,})$/;
// A slash command's name, typed at the very start of the message.
const COMMAND = /^\/([A-Za-z]*)$/;

/** The `/command`, `@mention` or `:emoji` being typed just before the caret, if any. */
export function findTrigger(text: string, caret: number): Trigger | null {
  const command = COMMAND.exec(text.slice(0, caret));
  if (command) return { kind: "command", query: command[1]!, start: 0 };
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  // ... the rest of the function is unchanged
```

Until Task 3 adds the command branch, `useSuggestions` falls through to its emoji branch for `"command"`, so typing `/sh` briefly lists emoji. That's expected between tasks. It compiles, because `useSuggestions` only switches on `"mention"`.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm test -- autocomplete` then `pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Stage**

```bash
git -c safe.directory='*' add clients/web/src/chat/autocomplete.ts clients/web/src/chat/autocomplete.test.ts
```

---

### Task 2: Command registry, parser and the eight commands

**Files:**
- Create: `clients/web/src/chat/commands.ts`
- Test: `clients/web/src/chat/commands.test.tsx` (`.tsx` because it renders `MarkdownView`)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `type CommandContext = { setStatus: (text: string) => Promise<unknown> }`
  - `type CommandResult = { send: string } | { done: true } | { error: string }`
  - `type Command = { name: string; args?: string; description: string; run: (args: string, ctx: CommandContext) => CommandResult | Promise<CommandResult> }`
  - `const COMMANDS: Command[]`
  - `function isCommand(text: string): boolean`: true when `text` should go through `runCommand` (a parsable command, or the `//` escape).
  - `function parseCommand(text: string): { name: string; args: string } | null`
  - `function runCommand(text: string, ctx: CommandContext): Promise<CommandResult | null>`: `null` means "not a command, send as typed".
  - `function roll(spec: string, rand?: (max: number) => number): CommandResult`
  - `function flip(rand?: (max: number) => number): CommandResult`
  - `function randomInt(max: number): number`: uniform in `[0, max)` from `crypto.getRandomValues`.

- [ ] **Step 1: Write the failing tests**

`clients/web/src/chat/commands.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { COMMANDS, flip, isCommand, parseCommand, randomInt, roll, runCommand, type CommandContext } from "./commands";
import { MarkdownView } from "./Markdown";

// The session module creates the client from window.location, which Node lacks; MarkdownView needs neither.
vi.mock("@/session", () => ({ client: {}, useApp: () => undefined }));

const opts = { custom: new Map(), shortcodes: new Map(), users: new Map(), meId: "1" };
/** The text a message shows once its Markdown is rendered. */
const rendered = (md: string) => renderToStaticMarkup(<MarkdownView text={md} options={opts} />).replace(/<[^>]+>/g, "");

const ctx = (): CommandContext & { statuses: string[] } => {
  const statuses: string[] = [];
  return { statuses, setStatus: async (t) => { statuses.push(t); } };
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
    expect((await send("/flip")) as { send: string }).toMatchObject({ send: expect.stringMatching(/^🪙 (Heads|Tails)$/) });
    expect((await send("/roll")) as { send: string }).toMatchObject({ send: expect.stringMatching(/^🎲 1d20: \*\*([1-9]|1\d|20)\*\*$/) });
  });

  it("lists every command once, in lower case", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toEqual(["shrug", "tableflip", "unflip", "me", "spoiler", "roll", "flip", "status"]);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- commands`
Expected: FAIL with "Failed to resolve import ./commands".

- [ ] **Step 3: Implement**

`clients/web/src/chat/commands.ts`:

```ts
// Slash commands typed at the start of the composer. Pure: the composer passes
// side effects in through CommandContext.

export type CommandContext = { setStatus: (text: string) => Promise<unknown> };
export type CommandResult = { send: string } | { done: true } | { error: string };
export type Command = {
  name: string;
  args?: string; // hint shown in the picker, e.g. "[NdM]"
  description: string;
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
  {
    name: "status", args: "[text]", description: "Sets your custom status; empty clears it",
    run: async (a, ctx) => {
      if (a.length > MAX_STATUS) return { error: `A status can be at most ${MAX_STATUS} characters` };
      await ctx.setStatus(a);
      return { done: true };
    },
  },
];

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

/** Runs `text` if it is a command. null: not a command, send it as typed. */
export async function runCommand(text: string, ctx: CommandContext): Promise<CommandResult | null> {
  const t = text.trim();
  if (t.startsWith("//")) return { send: t.slice(1) };
  const parsed = parseCommand(t);
  if (!parsed) return null;
  const cmd = COMMANDS.find((c) => c.name === parsed.name);
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
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm test -- commands` then `pnpm typecheck`
Expected: PASS. If the shrug render row fails, print `rendered(SHRUG)` and adjust the escaping until it reads `¯\_(ツ)_/¯`. The rendered text is the requirement; the source string is not.

- [ ] **Step 5: Stage**

```bash
git -c safe.directory='*' add clients/web/src/chat/commands.ts clients/web/src/chat/commands.test.tsx
```

---

### Task 3: Picker and composer wiring, plus e2e

**Files:**
- Modify: `clients/web/src/chat/AutocompleteList.tsx` (command branch in `useSuggestions`, listbox label)
- Modify: `clients/web/src/app/Composer.tsx` (`submit` runs commands)
- Modify: `clients/web/e2e/chat.spec.ts` (slash-command steps after the spoiler check, around line 247)

**Interfaces:**
- Consumes:
  - Task 1: `Trigger` with `kind: "command"`.
  - Task 2: `COMMANDS`, `isCommand(text)`, `runCommand(text, ctx)`, `CommandContext`.
  - Existing: `client.updateMe({ custom_status })` from `@datrope/core`.
- Produces: the listbox named **"Command suggestions"** with options named `/name [args] description`.

- [ ] **Step 1: Write the failing e2e steps**

In `clients/web/e2e/chat.spec.ts`, directly after the spoiler block (after the line `await expect.poll(() => shown.evaluate(...)).not.toBe("rgba(0, 0, 0, 0)");`) and before `// 7. bob starts a DM`, add:

```ts
  // Slash commands: the picker completes /shrug, and the face arrives with its backslash.
  const box = alice.getByLabel("Message", { exact: true });
  await box.fill("/shr");
  await expect(alice.getByRole("listbox", { name: "Command suggestions" }).getByRole("option", { name: /^\/shrug/ })).toBeVisible();
  await box.press("Tab");
  await expect(box).toHaveValue("/shrug ");
  await box.pressSequentially("hi");
  await box.press("Enter");
  await expect(bob.getByRole("article").filter({ hasText: "hi ¯\\_(ツ)_/¯" })).toBeVisible();
  await expect(box).toHaveValue("");

  // An unknown command is not sent, and the text stays for fixing.
  await send(alice, "/nope");
  await expect(alice.getByRole("alert").filter({ hasText: "Unknown command /nope" })).toBeVisible();
  await expect(box).toHaveValue("/nope");
  await box.fill("");
```

- [ ] **Step 2: Run the e2e to verify it fails**

The e2e needs the compose stack (see the `local-dev-environment` memory: run against a fresh `datrope-e2e` project, `down -v` afterwards; port override files may be needed if `datrope-dev-livekit` is running). If the stack can't run locally, skip this step and rely on CI. Say so in the task report.

Run: `pnpm e2e` (from `clients/web`)
Expected: FAIL at the `Command suggestions` listbox (not found).

- [ ] **Step 3: Add the command branch to the suggestions**

In `clients/web/src/chat/AutocompleteList.tsx`, add the import:

```ts
import { COMMANDS } from "./commands";
```

Inside `useSuggestions`'s `useMemo`, right after `const q = trigger.query;`:

```tsx
    if (trigger.kind === "command") {
      return rank(q, COMMANDS.map((c) => ({ key: c.name, c }))).map(({ c }) => ({
        id: `command-${c.name}`, insert: `/${c.name} `, text: `/${c.name}${c.args ? ` ${c.args}` : ""}`, hint: c.description,
        icon: <span className="grid size-6 place-items-center rounded-md bg-muted text-xs font-semibold" aria-hidden="true">/</span>,
      }));
    }
```

Replace the listbox's `aria-label` expression in `Autocomplete` with a lookup:

```tsx
const LABELS: Record<Trigger["kind"], string> = {
  mention: "Member suggestions",
  emoji: "Emoji suggestions",
  command: "Command suggestions",
};
```

(declare it above `Autocomplete`), and use `aria-label={LABELS[kind]}`.

`rank` returns at most 8 items, and there are exactly 8 commands, so a bare `/` lists them all.

- [ ] **Step 4: Run commands from `submit`**

In `clients/web/src/app/Composer.tsx`:

Add the import:

```ts
import { isCommand, runCommand, type CommandContext } from "@/chat/commands";
```

Next to the other refs (after `const form = useRef<HTMLFormElement>(null);`), add a guard so a second Enter can't run a command twice while an async one (`/status`) is in flight:

```ts
  const running = useRef(false);
```

Replace the whole `submit` function with:

```ts
  const post = (content: string) => {
    setText("");
    setFiles([]);
    setError(undefined);
    setReplyTo(null);
    void (async () => {
      // From a detached window (an old message jumped to), go back to the present first.
      // If that fails, the message is sent anyway (the store still shows my own message).
      if (client.store.getState().messages[channelId]?.hasNewer) await client.loadLatest(channelId).catch(() => undefined);
      await client.send(channelId, content, ready, replyTo ?? undefined);
    })().catch((e) => setError(errorText(e)));
  };

  const submit = () => {
    const content = text.trim();
    if (uploading || (!content && ready.length === 0)) return;
    if (!isCommand(content)) return post(content);
    if (running.current) return;
    running.current = true;
    const ctx: CommandContext = { setStatus: (custom_status) => client.updateMe({ custom_status }) };
    void runCommand(content, ctx)
      .then((result) => {
        if (!result) return post(content);
        if ("error" in result) return setError(result.error); // keep the text for fixing
        if ("send" in result) return post(result.send);
        setText(""); // done: a side effect only
        setError(undefined);
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => { running.current = false; });
  };
```

The non-command path is the old code, moved into `post`, so plain messages behave exactly as before (the text is cleared synchronously).

- [ ] **Step 5: Typecheck and unit tests**

Run: `pnpm typecheck` then `pnpm test`
Expected: PASS, all suites.

- [ ] **Step 6: Check it in the browser**

Start `datrope-server` and `datrope-web` with `preview_start` (names from `.claude/launch.json`), log in, and in a text channel:
- Type `/`: "Command suggestions" lists all 8 commands. Arrow keys plus Tab complete. Esc closes.
- `/shrug hi` → the message shows `hi ¯\_(ツ)_/¯`.
- `/roll 2d6` → `🎲 2d6: a + b = **n**` with bold total.
- `/me waves` → italic. `/spoiler x` → hidden spoiler.
- `/status testing` → the profile strip shows "testing" and the box clears. `/status` clears it.
- `/nope` → error under the box, text kept. `//nope` → sends `/nope`. `/usr/bin` → sent as typed.
- `/shrug` while replying → sent as a reply.

Take a screenshot of the open picker for the task report.

- [ ] **Step 7: Run the e2e (if the stack runs locally)**

Run: `pnpm e2e`
Expected: PASS.

- [ ] **Step 8: Stage**

```bash
git -c safe.directory='*' add clients/web/src/chat/AutocompleteList.tsx clients/web/src/app/Composer.tsx clients/web/e2e/chat.spec.ts
```
