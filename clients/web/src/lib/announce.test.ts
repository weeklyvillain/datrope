import { describe, expect, it } from "vitest";
import { announceStep, announcement, freshMessages, plainPreview } from "./announce";

describe("plainPreview", () => {
  it("strips markdown and collapses whitespace", () => {
    expect(plainPreview("**hi** _there_\n\n> quote `x`")).toBe("hi there quote x");
  });
  it("hides spoilers and shortens custom emoji and mentions", () => {
    expect(plainPreview("a ||secret|| <:wave:123> <@456>")).toBe("a spoiler :wave: @mention");
  });
  it("cuts at 100 characters on a word", () => {
    const s = plainPreview("word ".repeat(40));
    expect(s.length).toBeLessThanOrEqual(101);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("announcement", () => {
  it("reads one message as author: text", () => {
    expect(announcement([{ author: "bob", text: "hello" }])).toBe("bob: hello");
  });
  it("summarises a burst", () => {
    expect(announcement([{ author: "bob", text: "a" }, { author: "amy", text: "b" }, { author: "bob", text: "c" }]))
      .toBe("bob: a, and 2 more");
  });
  it("says attachment when there is no text", () => {
    expect(announcement([{ author: "bob", text: "" }])).toBe("bob: attachment");
  });
  it("is empty for no messages", () => expect(announcement([])).toBe(""));
});

describe("freshMessages", () => {
  const me = "me";
  const m = (id: string, author = "bob", extra: object = {}) => ({ id, author: { id: author }, ...extra });
  it("own pending send confirming announces nothing, others' meanwhile are announced", () => {
    const before = [m("1"), m("2"), m("pending:x", me, { pending: true })];
    const a = freshMessages(before, "2", me);
    expect(a.fresh).toEqual([]);
    const after = [m("1"), m("2"), m("3", "amy"), m("4", me)];
    const b = freshMessages(after, a.mark, me);
    expect(b.fresh.map((x) => x.id)).toEqual(["3"]);
    expect(b.mark).toBe("4");
  });
  it("prepending an older page announces nothing", () => {
    expect(freshMessages([m("0"), m("1"), m("2")], "2", me).fresh).toEqual([]);
  });
  it("deleting the newest message announces nothing", () => {
    const r = freshMessages([m("1")], "2", me);
    expect(r.fresh).toEqual([]);
    expect(r.mark).toBe("2"); // high-water mark never moves back
  });
  it("a refetch with the same latest page announces nothing", () => {
    expect(freshMessages([m("5"), m("6")], "6", me).fresh).toEqual([]);
  });
  it("undefined mark gives no fresh items and sets the mark", () => {
    expect(freshMessages([m("1"), m("2")], undefined, me)).toEqual({ fresh: [], mark: "2" });
  });
  it("skips system messages", () => {
    expect(freshMessages([m("1"), m("2", "bob", { kind: "join" })], "1", me).fresh).toEqual([]);
  });
});

describe("announceStep", () => {
  const me = "me";
  const m = (id: string, author = "bob") => ({ id, author: { id: author } });
  it("seeds without announcing, then announces what arrives", () => {
    const a = announceStep({ items: [m("1"), m("2")], hasMore: true }, undefined, me);
    expect(a).toEqual({ fresh: [], state: { mark: "2", detached: false } });
    const b = announceStep({ items: [m("1"), m("2"), m("3")], hasMore: true }, a.state, me);
    expect(b.fresh.map((x) => x.id)).toEqual(["3"]);
  });
  it("announces the first message in a channel that loaded empty", () => {
    const a = announceStep({ items: [], hasMore: false }, undefined, me);
    expect(a.state).toEqual({ mark: "0", detached: false });
    expect(announceStep({ items: [m("7")], hasMore: false }, a.state, me).fresh.map((x) => x.id)).toEqual(["7"]);
  });
  it("stays unseeded while the list holds only a pending send", () => {
    const pending = { id: "pending:x", pending: true, author: { id: me } };
    expect(announceStep({ items: [pending], hasMore: true }, undefined, me).state).toBeUndefined();
  });
  it("says nothing while detached, and re-seeds instead of announcing the backlog on return to the present", () => {
    const a = announceStep({ items: [m("1"), m("2")], hasMore: true, hasNewer: true }, undefined, me);
    const b = announceStep({ items: [m("1"), m("2"), m("3")], hasMore: true, hasNewer: true }, a.state, me);
    expect(b.fresh).toEqual([]);
    const c = announceStep({ items: [m("1"), m("2"), m("3"), m("4"), m("5")], hasMore: true, hasNewer: false }, b.state, me);
    expect(c).toEqual({ fresh: [], state: { mark: "5", detached: false } });
    expect(announceStep({ items: [m("4"), m("5"), m("6")], hasMore: true }, c.state, me).fresh.map((x) => x.id)).toEqual(["6"]);
  });
});
