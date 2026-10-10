import { Hash, Webhook } from "lucide-react";
import { describe, expect, it } from "vitest";
import { CHANNEL_TYPES, channelIcon, isUnreadType } from "./channel-types";

describe("channel types", () => {
  it("lists the six creatable types in order", () => {
    expect(CHANNEL_TYPES.map((t) => t.value)).toEqual(["text", "voice", "webhook", "announcement", "forum", "gallery"]);
  });
  it("falls back to Hash for an unknown type", () => {
    expect(channelIcon("nope")).toBe(Hash);
    expect(channelIcon("webhook")).toBe(Webhook);
  });
  it("shows unread for channels with messages, forums included", () => {
    expect(["text", "webhook", "announcement", "forum", "gallery"].every(isUnreadType)).toBe(true);
    expect(["voice", "welcome", "thread", "dm", undefined].some(isUnreadType)).toBe(false);
  });
});
