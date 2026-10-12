import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../session", () => ({ client: {}, displayName: String }));

import { player, playerStore } from "./player-store";
import type { Track } from "./queue";

const track = (k: string): Track => ({ key: k, title: `${k}.mp3`, subtitle: "#music · alice", src: `/a/${k}` });
const state = () => playerStore.getState();

describe("player store", () => {
  afterEach(() => {
    player.clear();
    player.setRepeat("off");
  });

  it("failed() skips to the next track, keeps playing and says so", () => {
    player.play([track("a"), track("b")]);
    const seq = state().seq;
    player.failed();
    expect(state().queue.index).toBe(1);
    expect(state().playing).toBe(true);
    expect(state().seq).toBeGreaterThan(seq);
    expect(state().notice).toBe("Couldn't play a.mp3. Skipped.");
  });

  it("next, prev and ended clear a skip notice", () => {
    for (const move of [player.next, player.prev, player.ended]) {
      player.play([track("a"), track("b"), track("c")]);
      player.failed();
      expect(state().notice).toBeDefined();
      move();
      expect(state().notice).toBeUndefined();
    }
  });

  it("failed() on the last track stops", () => {
    player.play([track("a")]);
    player.failed();
    expect(state().playing).toBe(false);
    expect(state().notice).toBe("Couldn't play a.mp3. Skipped.");
  });

  it("ended() with repeat one keeps the queue but bumps seq so the bar replays", () => {
    player.play([track("a"), track("b")]);
    player.setRepeat("one");
    const { queue, seq } = state();
    player.ended();
    expect(state().queue).toBe(queue);
    expect(state().playing).toBe(true);
    expect(state().seq).toBeGreaterThan(seq);
  });

  it("next() on a one-track queue with repeat all and prev() at the start bump seq", () => {
    player.play([track("a")]);
    player.setRepeat("all");
    let seq = state().seq;
    player.next();
    expect(state().seq).toBeGreaterThan(seq);
    seq = state().seq;
    player.prev();
    expect(state().seq).toBeGreaterThan(seq);
  });

  it("add() bumps seq only when it starts an empty queue", () => {
    player.add([track("a")]);
    expect(state().playing).toBe(true);
    const seq = state().seq;
    player.add([track("b")]);
    expect(state().seq).toBe(seq);
  });

  it("play() with shuffle queues every track and starts at the first", () => {
    const keys = "abcdefghij".split("");
    const rand = vi.spyOn(Math, "random").mockReturnValue(0.75);
    player.play(keys.map(track), 0, true);
    rand.mockRestore();
    expect(state().queue.index).toBe(0);
    expect(state().queue.tracks.map((t) => t.key).sort()).toEqual(keys);
  });

  it("play() drops repeated tracks and keeps the chosen one current", () => {
    player.play([track("a"), track("b"), track("a"), track("c")], 3);
    expect(state().queue.tracks.map((t) => t.key)).toEqual(["a", "b", "c"]);
    expect(state().queue.index).toBe(2);
  });

  it("failed() stops once every track in the queue has failed in a row, even on repeat all", () => {
    player.play([track("a"), track("b"), track("c")]);
    player.setRepeat("all");
    player.failed();
    player.failed();
    expect(state().playing).toBe(true);
    player.failed();
    expect(state().playing).toBe(false);
    expect(state().notice).toBe("Couldn't play c.mp3. Skipped.");
  });

  it("a track that starts playing resets the failure count", () => {
    player.play([track("a"), track("b")]);
    player.setRepeat("all");
    player.failed();
    player.started();
    player.failed();
    expect(state().playing).toBe(true);
  });

  it("prev() on an empty queue does not start playing", () => {
    player.prev();
    expect(state().playing).toBe(false);
  });
});
