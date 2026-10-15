import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReminderCardView } from "./ReminderCard";

vi.mock("../../session", () => ({ client: {} }));

describe("ReminderCardView", () => {
  it("shows the note and the live quote", () => {
    const html = renderToStaticMarkup(<ReminderCardView onJump={() => {}} info={{
      note: "review release notes", target: { channel_id: "1", message_id: "2" },
      quote: { author_name: "Maja", channel_name: "general", created_at: "2026-10-14T12:02:00Z", excerpt: "Can someone review?" },
    }} />);
    expect(html).toContain("Reminder: <strong");
    expect(html).toContain("review release notes");
    expect(html).toContain("Maja · #general");
    expect(html).toContain("Jump to message");
  });
  it("says when the message is unavailable", () => {
    const html = renderToStaticMarkup(<ReminderCardView onJump={() => {}} info={{ note: "", unavailable: true }} />);
    expect(html).toContain("Message unavailable — it was deleted, or you no longer have access.");
    expect(html).not.toContain("Jump to message");
  });
  it("a free-text reminder is just the note", () => {
    const html = renderToStaticMarkup(<ReminderCardView onJump={() => {}} info={{ note: "stretch" }} />);
    expect(html).not.toContain("Message unavailable");
    expect(html).not.toContain("Jump to message");
  });
});
