import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Wheel, wheelSteps } from "./Wheel";
import { ReminderForm } from "./ReminderDialog";

vi.mock("../../session", () => ({ client: {}, errorText: String }));

const now = new Date(2026, 9, 14, 14, 2);

describe("Wheel", () => {
  it("is a spinbutton showing its neighbours", () => {
    const html = renderToStaticMarkup(<Wheel label="Hour" items={["08", "09", "10"]} index={1} onChange={() => {}} />);
    expect(html).toContain('role="spinbutton"');
    expect(html).toContain('aria-label="Hour"');
    expect(html).toContain('aria-valuetext="09"');
    expect(html).toContain(">08<");
    expect(html).toContain(">10<");
  });
  it("builds up small scroll deltas into steps", () => {
    expect(wheelSteps(0, 100)).toEqual({ steps: 2, rest: 0 }); // a mouse notch
    expect(wheelSteps(0, 4)).toEqual({ steps: 0, rest: 4 }); // a trackpad tick
    expect(wheelSteps(48, 4)).toEqual({ steps: 1, rest: 2 });
    expect(wheelSteps(30, -60)).toEqual({ steps: -1, rest: -10 }); // turning back drops what had built up
  });
});

describe("ReminderForm", () => {
  it("previews the default time and quotes the message", () => {
    const html = renderToStaticMarkup(<ReminderForm now={now} initial={{ day: 0, hour: 15, minute: 15 }}
      message={{ id: "1", channel_id: "2", authorName: "Maja", channelName: "general", excerpt: "Review the notes?" }} onClose={() => {}} />);
    expect(html).toContain("in 1 h 13 min");
    expect(html).toContain("Maja · #general");
    expect(html).not.toContain("disabled=\"\"");
  });
  it("disables Set for a time that has passed", () => {
    const html = renderToStaticMarkup(<ReminderForm now={now} initial={{ day: 0, hour: 9, minute: 0 }} onClose={() => {}} />);
    expect(html).toContain("That time has passed");
    expect(html).toMatch(/disabled=""[^<]*>Set reminder</);
  });
  it("previews a later day", () => {
    const html = renderToStaticMarkup(<ReminderForm now={now} initial={{ day: 1, hour: 9, minute: 0 }} onClose={() => {}} />);
    expect(html).toContain("in 18 h 58 min");
  });
});
