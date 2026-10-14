import { describe, expect, it } from "vitest";
import { parseWheel, reelLayout, wheel } from "./wheel";

const fixed = (v: number) => () => v; // rand returns a 0-based index

describe("wheel", () => {
  it.each([
    ["Pizza, Sushi, Tacos", 1, "🎡 Spun the wheel: Pizza, Sushi, Tacos → **Sushi**"],
    ["a,b", 0, "🎡 Spun the wheel: a, b → **a**"],
    [" a ,, b\nc ", 2, "🎡 Spun the wheel: a, b, c → **c**"],
    ["*bold*, _it_, a|b", 0, String.raw`🎡 Spun the wheel: \*bold\*, \_it\_, a\|b → **\*bold\***`],
  ])("%j", (args, pick, want) => {
    expect(wheel(args, fixed(pick))).toEqual({ send: want });
  });

  it.each([
    ["", "Usage: /wheel <option, option, …>"],
    ["only one", "Usage: /wheel <option, option, …>"],
    [Array.from({ length: 21 }, (_, i) => `o${i}`).join(","), "A wheel takes 2–20 options"],
    [`a, ${"x".repeat(51)}`, "Each option can be at most 50 characters"],
    ["a → b, c", "Options can't contain →"],
  ])("%j is refused", (args, error) => {
    expect(wheel(args, fixed(0))).toEqual({ error });
  });
});

describe("parseWheel", () => {
  it("reads back what /wheel sends", () => {
    for (const [args, pick] of [["Pizza, Sushi, Tacos", 2], ["*bold*, _it_, a|b, [x](y), <@1>, back\\slash", 3], ["same, same, other", 1]] as const) {
      const r = wheel(args, fixed(pick));
      if (!("send" in r)) throw new Error("expected send");
      const parsed = parseWheel(r.send);
      expect(parsed).not.toBeNull();
      const options = args.split(",").map((s) => s.trim());
      expect(parsed!.options).toEqual(options);
      expect(parsed!.options[parsed!.winner]).toBe(options[pick]);
    }
  });

  it.each([
    "hello",
    "🎡 Spun the wheel: a → **a**", // one option
    "🎡 Spun the wheel: a, b → **c**", // winner not an option
    "🎡 Spun the wheel: a, b → **a** extra",
    "🎡 Spun the wheel: a, b → a",
    "x 🎡 Spun the wheel: a, b → **a**",
    "🎡 Spun the wheel: a, , b → **a**",
  ])("%j is plain text", (content) => {
    expect(parseWheel(content)).toBeNull();
  });
});

describe("reelLayout", () => {
  it.each([[2, 1], [6, 4], [20, 19]])("%i options stop inside the winning tile (%i)", (n, winner) => {
    const wheel = { options: Array.from({ length: n }, (_, i) => `o${i}`), winner };
    for (const jitter of [0, 0.5, 0.999]) {
      const { tiles, winnerTile, start, end } = reelLayout(wheel, jitter);
      expect(tiles[winnerTile]).toBe(winner);
      expect(winnerTile).toBeGreaterThanOrEqual(30);
      expect(tiles.length - winnerTile).toBeGreaterThan(3); // tiles to the right of the marker
      const left = winnerTile * 8.5;
      expect(end).toBeGreaterThan(left);
      expect(end).toBeLessThan(left + 8);
      expect(start).toBe(2 * 8.5 + 4);
    }
  });
});
