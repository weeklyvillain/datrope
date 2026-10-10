import { describe, expect, it } from "vitest";
import { authorKey, shownAuthor, webhookAuthor } from "./message-author";

const bob = { id: "2", username: "bob", display_name: "Bob", custom_status: "" };

describe("message authors", () => {
  it("groups by user, or by webhook and name", () => {
    expect(authorKey({ author: bob })).toBe(authorKey({ author: { ...bob, display_name: "Robert" } }));
    const ci = { webhook: { id: "7", name: "CI" } };
    expect(authorKey(ci)).toBe(authorKey({ webhook: { id: "7", name: "CI", avatar_url: "/x" } }));
    expect(authorKey(ci)).not.toBe(authorKey({ webhook: { id: "7", name: "Deploys" } })); // a username override
    expect(authorKey(ci)).not.toBe(authorKey({ webhook: { id: "8", name: "CI" } }));
    expect(authorKey({ webhook: { name: "CI" } })).toBe(authorKey({ webhook: { name: "CI" } })); // the webhook was deleted
    expect(authorKey(ci)).not.toBe(authorKey({ author: { ...bob, id: "7" } }));
  });

  it("shows the live profile, the snapshot, or the webhook", () => {
    expect(shownAuthor({ author: bob }, { ...bob, display_name: "Robert" }).display_name).toBe("Robert");
    expect(shownAuthor({ author: bob }).display_name).toBe("Bob");
    expect(shownAuthor({ webhook: { id: "7", name: "CI", avatar_url: "/a" } }))
      .toEqual({ id: "webhook:7", username: "CI", display_name: "CI", avatar_url: "/a" });
    expect(shownAuthor(undefined).display_name).toBe("Unknown");
    expect(webhookAuthor({ name: "CI" }).id).toBe("webhook:CI");
  });
});
