import { describe, expect, it } from "vitest";
import { parseChannelCards } from "./channelCards";

describe("parseChannelCards", () => {
  it("splits markdown and cards", () => {
    const md = '# Hi\nWelcome!\n\n[[channel:general "Chat about anything"]]\n[[channel:Club · lounge "Old club lounge"]]\n\nBye';
    expect(parseChannelCards(md)).toEqual([
      { kind: "markdown", text: "# Hi\nWelcome!\n" },
      { kind: "card", name: "general", description: "Chat about anything" },
      { kind: "card", name: "Club · lounge", description: "Old club lounge" },
      { kind: "markdown", text: "\nBye" },
    ]);
  });

  it("leaves inline or malformed cards as markdown", () => {
    const md = 'See [[channel:general "x"]] here\n[[channel:general]]';
    expect(parseChannelCards(md)).toEqual([{ kind: "markdown", text: md }]);
  });
});
