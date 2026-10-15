import { describe, expect, it } from "vitest";
import { remarkChat, type ChatOptions } from "./remarkChat";

const base: ChatOptions = { custom: new Map(), shortcodes: null, users: new Map() };
type N = { type: string; value?: string; children?: N[]; data?: { hProperties?: Record<string, unknown> } };
const run = (text: string, o: ChatOptions) => {
  const tree: N = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: text }] }] };
  remarkChat(o)(tree as never);
  return tree.children![0]!.children!;
};

describe("time mentions", () => {
  const time = { sentAt: "2026-03-10T18:00:00Z", tz: "Europe/Stockholm" };
  it("wraps a written time with the instant it means", () => {
    const nodes = run("gaming @ 9pm!", { ...base, time });
    expect(nodes.map((n) => n.type)).toEqual(["text", "chatTime", "text"]);
    expect(nodes[1]!.data!.hProperties).toMatchObject({ className: ["time-mention"], "data-time": "2026-03-10T20:00:00.000Z", "data-src": "9pm", "data-zone": "Europe/Stockholm" });
    expect(nodes[1]!.children![0]!.value).toBe("9pm");
  });
  it("marks a chip whose zone was written, not one in the sender's zone", () => {
    const written = run("at 9pm CET", { ...base, time })[1]!.data!.hProperties as Record<string, unknown>;
    const sender = run("at 9pm", { ...base, time })[1]!.data!.hProperties as Record<string, unknown>;
    expect(written).toHaveProperty("data-written", "");
    expect(sender).not.toHaveProperty("data-written");
  });
  it("leaves times alone without message time info (topics, previews)", () =>
    expect(run("gaming @ 9pm", base).map((n) => n.type)).toEqual(["text"]));
  it("does not convert a zoneless time in a message without a tz", () =>
    expect(run("at 9pm", { ...base, time: { sentAt: time.sentAt } }).map((n) => n.type)).toEqual(["text"]));
  it("still converts a time with a written zone in a message without a tz", () =>
    expect(run("at 9pm UTC", { ...base, time: { sentAt: time.sentAt } }).map((n) => n.type)).toEqual(["text", "chatTime"]));
  it("works next to mentions and emoji", () => {
    const nodes = run("@bob 21:00 :x:", { ...base, users: new Map([["bob", { id: "1", name: "Bob" }]]), time });
    expect(nodes.map((n) => n.type)).toEqual(["chatMention", "text", "chatTime", "text"]);
  });
});
