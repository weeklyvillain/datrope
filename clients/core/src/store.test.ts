import { describe, expect, it, vi } from "vitest";
import {
  addPending, applyEvent, applyReady, compareIds, customEmojiId, emojiList, soundList, initialState, isGated, markFailed, myChannelPerms, myThreadPerms, prependHistory,
  rolesByRank, voiceMembers, channelGroups, sidebarChannelIds, findUser, findDM, type State,
  replaceWindow, appendNewer, latestWindow, setMentions, markMentionsRead, ackLocal, setPoll, publicUser, canCreateInvites,
} from "./store";
import { ALL_PERMS, Perm, WEBHOOK_MASKED, hasPerm } from "./perms";
import type { Message, Ready, VoiceState, WatchState } from "./types";

const bob = { id: "2", username: "bob", display_name: "Bob", custom_status: "" };

const server = { id: "1", name: "Datrope", description: "", accent_color: "#2ecc71", owner_id: "10", created_at: "", rules_gate: false } as const;
const everyone = { id: "1", name: "@everyone", permissions: Perm.ViewChannel | Perm.SendMessages, position: 0, hoist: false, self_assignable: false, mentionable: false, description: "" };
const mod = { id: "2", name: "Mod", permissions: Perm.Kick, position: 1, hoist: true, color: "#4aa3ff", self_assignable: false, mentionable: false, description: "" } as const;
const me = { id: "20", username: "bob", display_name: "Bob", custom_status: "", is_admin: false, disabled: false, created_at: "" };
const ready = (over: Partial<Ready> = {}): Ready => ({
  session_id: "s", user: me, dms: [], presences: [{ user_id: "2", status: "online" }], read_states: [{ channel_id: "101", last_message_id: "25" }],
  voice_states: [], emoji: [], sounds: [], activities: [],
  server: {
    ...server, roles: [everyone, mod],
    members: [{ user: { id: "20", username: "bob", display_name: "Bob", custom_status: "" }, role_ids: [], joined_at: "", accepted_rules_at: "x" }],
    categories: [],
    channels: [
      { id: "100", type: "welcome", name: "welcome", position: -1, topic: "", overrides: [], tags: [], require_tag: false },
      { id: "101", type: "text", name: "general", position: 0, topic: "", overrides: [], tags: [], require_tag: false },
    ],
  },
  ...over,
});

function msg(id: string, extra: Partial<Message> = {}): Message {
  return { id, channel_id: "101", author: bob, content: `m${id}`, created_at: "2026-01-01T00:00:00Z", deleted: false, pinned: false, attachments: [], mentions: [], mention_roles: [], reactions: [], ...extra };
}

function loaded(): State {
  const s = applyReady(initialState, ready());
  return prependHistory(s, "101", [msg("20"), msg("10")], 50);
}

describe("store", () => {
  it("WATCH_UPDATE sets and clears a channel's watch, and keeps the server clock offset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const st: WatchState = {
        channel_id: "300", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", kind: "youtube", video_id: "dQw4w9WgXcQ",
        paused: false, position: 0, updated_at: 1_000_500, started_by: "20", last_actor: "20", last_action: "start",
      };
      let s = applyEvent(initialState, "WATCH_UPDATE", { channel_id: "300", state: st, server_now: 1_000_500 });
      expect(s.watch["300"]).toEqual(st);
      expect(s.serverOffset).toBe(500);
      s = applyEvent(s, "WATCH_UPDATE", { channel_id: "300", server_now: 1_000_800 });
      expect(s.watch["300"]).toBeNull();
      expect(s.serverOffset).toBe(800);
      expect(initialState.watch["300"]).toBeUndefined(); // not loaded
    } finally {
      vi.useRealTimers();
    }
  });
  it("applyReady forgets watches, so a reconnect re-fetches them", () => {
    const st: WatchState = {
      channel_id: "300", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", kind: "youtube", video_id: "dQw4w9WgXcQ",
      paused: false, position: 0, updated_at: 1_000_500, started_by: "20", last_actor: "20", last_action: "start",
    };
    let s = applyEvent(initialState, "WATCH_UPDATE", { channel_id: "300", state: st, server_now: 1_000_500 });
    expect(s.watch["300"]).toEqual(st);
    s = applyReady(s, ready());
    expect(s.watch["300"]).toBeUndefined();
    // and the stale-update guard starts over too
    s = applyEvent(s, "WATCH_UPDATE", { channel_id: "300", state: st, server_now: 500 });
    expect(s.watch["300"]).toEqual(st);
  });
  it("WATCH_UPDATE older than the last one applied for the channel is ignored", () => {
    const st: WatchState = {
      channel_id: "300", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", kind: "youtube", video_id: "dQw4w9WgXcQ",
      paused: false, position: 0, updated_at: 1_000_500, started_by: "20", last_actor: "20", last_action: "start",
    };
    let s = applyEvent(initialState, "WATCH_UPDATE", { channel_id: "300", state: { ...st, paused: true }, server_now: 2_000 });
    s = applyEvent(s, "WATCH_UPDATE", { channel_id: "300", state: st, server_now: 1_000 });
    expect(s.watch["300"]?.paused).toBe(true);
    s = applyEvent(s, "WATCH_UPDATE", { channel_id: "301", state: { ...st, channel_id: "301" }, server_now: 500 }); // other channel unaffected
    expect(s.watch["301"]).not.toBeUndefined();
  });
  it("guests cannot create invites even when their roles allow it", () => {
    const s = applyReady(initialState, ready({ server: { ...ready().server!, roles: [{ ...everyone, permissions: everyone.permissions | Perm.CreateInvite }, mod] } }));
    expect(canCreateInvites(s)).toBe(true);
    expect(canCreateInvites({ ...s, me: { ...s.me!, guest_expires_at: "2026-10-11T00:00:00Z" } })).toBe(false);
  });

  it("keeps the guest flag when a profile update comes from my own account", () => {
    const u = publicUser({ ...me, guest_expires_at: "2026-10-11T00:00:00Z" });
    expect(u.guest_expires_at).toBe("2026-10-11T00:00:00Z");
  });

  it("compares snowflake strings numerically", () => {
    expect(compareIds("9", "10")).toBeLessThan(0);
    expect(compareIds("10", "10")).toBe(0);
  });

  it("applies READY", () => {
    const s = applyReady(initialState, ready());
    expect(s.me?.id).toBe("20");
    expect(s.server?.server.name).toBe("Datrope");
    expect(s.server?.channelIds).toEqual(["100", "101"]);
    expect(rolesByRank(s).map((r) => r.name)).toEqual(["Mod", "@everyone"]);
    expect(s.presences["2"]).toBe("online");
    expect(s.readStates["101"].lastMessageId).toBe("25");
  });

  it("has no server for a non-member", () => {
    const s = applyReady(initialState, ready({ server: undefined }));
    expect(s.server).toBeNull();
  });

  it("updates the server and drops it when I am removed", () => {
    let s = applyReady(initialState, ready());
    s = applyEvent(s, "SERVER_UPDATE", { ...server, name: "Basement", accent_color: "#4aa3ff" });
    expect(s.server?.server.accent_color).toBe("#4aa3ff");
    s = applyEvent(s, "MEMBER_REMOVE", { user_id: "20" });
    expect(s.server).toBeNull();
    expect(s.channels["101"]).toBeUndefined();
  });

  it("adds a created channel to the server", () => {
    let s = applyReady(initialState, ready());
    s = applyEvent(s, "CHANNEL_CREATE", { id: "102", type: "voice", name: "Lounge", position: 1, overrides: [], tags: [], require_tag: false });
    expect(s.server?.channelIds).toEqual(["100", "101", "102"]);
    expect(s.dmIds).toEqual([]);
  });

  it("gates a member who has not accepted the rules", () => {
    const gated = ready();
    gated.server!.rules_gate = true;
    gated.server!.members![0].accepted_rules_at = undefined;
    const s = applyReady(initialState, gated);
    expect(isGated(s)).toBe(true);
    expect(myChannelPerms(s, "100")).toBe(Perm.ViewChannel);
    expect(myChannelPerms(s, "101")).toBe(0);
  });

  it("stores the welcome page and my custom status", () => {
    let s = applyReady(initialState, ready());
    s = applyEvent(s, "WELCOME_UPDATE", { channel_id: "100", markdown: "# Hi", rules_gate: false });
    expect(s.welcome?.markdown).toBe("# Hi");
    s = applyEvent(s, "USER_UPDATE", { id: "20", username: "bob", display_name: "Bob", custom_status: "away" });
    expect(s.me?.custom_status).toBe("away");
    expect(s.server?.members["20"].user.custom_status).toBe("away");
  });

  it("keeps history oldest-first and marks whether more exists", () => {
    const s = loaded();
    expect(s.messages["101"].items.map((m) => m.id)).toEqual(["10", "20"]);
    expect(s.messages["101"].hasMore).toBe(false);
  });

  it("replaces a pending message when the server echoes its nonce", () => {
    let s = addPending(loaded(), "101", "n1", "hello");
    expect(s.messages["101"].items.at(-1)).toMatchObject({ pending: true, content: "hello" });
    s = applyEvent(s, "MESSAGE_CREATE", msg("30", { author: { id: "20", username: "bob", display_name: "Bob", custom_status: "" }, content: "hello", nonce: "n1" }));
    const items = s.messages["101"].items;
    expect(items.map((m) => m.id)).toEqual(["10", "20", "30"]);
    expect(items.some((m) => m.pending)).toBe(false);
    expect(s.readStates["101"]).toEqual({ lastMessageId: "30", lastReadId: "30" });
    // The HTTP response may arrive after the event; applying it again is harmless.
    expect(applyEvent(s, "MESSAGE_CREATE", msg("30")).messages["101"].items).toHaveLength(3);
  });

  it("keeps a confirmed message's nonce through MESSAGE_UPDATE, which carries none", () => {
    let s = addPending(loaded(), "101", "n1", "see https://example.com");
    s = applyEvent(s, "MESSAGE_CREATE", msg("30", { content: "see https://example.com", nonce: "n1" }));
    s = applyEvent(s, "MESSAGE_UPDATE", msg("30", { content: "see https://example.com", edited_at: "2026-01-01T00:01:00Z" }));
    expect(s.messages["101"].items.at(-1)).toMatchObject({ id: "30", nonce: "n1", edited_at: "2026-01-01T00:01:00Z" });
  });

  it("marks a failed send", () => {
    const s = markFailed(addPending(loaded(), "101", "n1", "x"), "101", "n1");
    expect(s.messages["101"].items.at(-1)).toMatchObject({ pending: true, failed: true });
  });

  it("soft-deletes messages", () => {
    const s = applyEvent(loaded(), "MESSAGE_DELETE", { id: "10", channel_id: "101" });
    expect(s.messages["101"].items[0]).toMatchObject({ deleted: true, content: "" });
  });

  it("deleting a pinned message unpins it", () => {
    let s = prependHistory(applyReady(initialState, ready()), "101", [msg("10", { pinned: true, pinned_at: "2026-01-02T00:00:00Z" })], 50);
    s = applyEvent(s, "MESSAGE_DELETE", { id: "10", channel_id: "101" });
    const m = s.messages["101"].items[0];
    expect(m).toMatchObject({ deleted: true, pinned: false });
    expect(m.pinned_at).toBeUndefined();
  });

  it("removes other members", () => {
    const s = applyEvent(loaded(), "MEMBER_REMOVE", { user_id: "2" });
    expect(Object.keys(s.server!.members)).toEqual(["20"]);
  });

  it("adds, updates, and deletes channels", () => {
    let s = applyEvent(loaded(), "CHANNEL_CREATE", { id: "301", type: "text", name: "random", position: 1, overrides: [], tags: [], require_tag: false });
    expect(s.server?.channelIds).toEqual(["100", "101", "301"]);
    s = applyEvent(s, "CHANNEL_UPDATE", { id: "301", type: "text", name: "memes", position: 1, overrides: [], tags: [], require_tag: false });
    expect(s.channels["301"].name).toBe("memes");
    s = applyEvent(s, "CHANNEL_DELETE", { id: "301" });
    expect(s.server?.channelIds).toEqual(["100", "101"]);
  });

  it("tracks typing and clears it when that user posts", () => {
    let s = applyEvent(loaded(), "TYPING_START", { channel_id: "101", user_id: "2", at: "2026-01-01T00:00:00Z" }, 1000);
    expect(s.typing["101"]["2"]).toBe(11_000);
    s = applyEvent(s, "MESSAGE_CREATE", msg("40"));
    expect(s.typing["101"]["2"]).toBeUndefined();
  });

  it("tracks who is in voice", () => {
    const inLounge: VoiceState = {
      user_id: "2", channel_id: "301", self_mute: false, self_deaf: false, server_mute: false, camera: false, screen: false,
    };
    let s = applyReady(initialState, { ...ready(), voice_states: [inLounge] });
    expect(voiceMembers(s, "301")).toEqual([inLounge]);
    expect(voiceMembers(s, "101")).toEqual([]);

    s = applyEvent(s, "VOICE_STATE_UPDATE", { ...inLounge, self_mute: true });
    expect(voiceMembers(s, "301")[0].self_mute).toBe(true);

    s = applyEvent(s, "VOICE_STATE_UPDATE", { user_id: "2", self_mute: false, self_deaf: false, server_mute: false, camera: false, screen: false });
    expect(voiceMembers(s, "301")).toEqual([]); // no channel_id: left voice
    expect(s.voice).toEqual({});
  });

  it("forgets voice states of a deleted channel", () => {
    const inGeneral: VoiceState = {
      user_id: "2", channel_id: "101", self_mute: false, self_deaf: false, server_mute: false, camera: true, screen: false,
    };
    let s = applyReady(initialState, { ...ready(), voice_states: [inGeneral] });
    s = applyEvent(s, "CHANNEL_DELETE", { id: "101" });
    expect(s.voice).toEqual({});
  });

  it("applies POLL_UPDATE counts and keeps my votes through MESSAGE_UPDATE", () => {
    const poll = {
      question: "Pizza?", multi: false, anonymous: false, ended: false, total_voters: 1, my_votes: [0],
      options: [{ text: "Yes", count: 1 }, { text: "No", count: 0 }],
    };
    let s = prependHistory(applyReady(initialState, ready()), "101", [msg("500", { poll })], 50);
    s = applyEvent(s, "POLL_UPDATE", { channel_id: "101", message_id: "500", options: [{ count: 1 }, { count: 2 }], total_voters: 3, ended: true });
    expect(s.messages["101"].items[0].poll).toEqual({
      ...poll, total_voters: 3, ended: true, options: [{ text: "Yes", count: 1 }, { text: "No", count: 2 }],
    });
    // A pin republishes the message; events never carry my_votes, so my copy wins.
    s = applyEvent(s, "MESSAGE_UPDATE", msg("500", { pinned: true, poll: { ...poll, my_votes: [] } }));
    expect(s.messages["101"].items[0]).toMatchObject({ pinned: true, poll: { my_votes: [0], total_voters: 3 } });
    // A vote's response only brings my_votes; its (older) counts never overwrite POLL_UPDATE's.
    s = setPoll(s, "101", "500", { ...poll, my_votes: [1] });
    expect(s.messages["101"].items[0].poll).toMatchObject({
      my_votes: [1], total_voters: 3, ended: true, options: [{ text: "Yes", count: 1 }, { text: "No", count: 2 }],
    });
    // POLL_UPDATE for a message I have not loaded changes nothing.
    expect(applyEvent(s, "POLL_UPDATE", { channel_id: "101", message_id: "999", options: [], total_voters: 0, ended: false })).toEqual(s);
  });

  it("keeps my votes in the mentions inbox through MESSAGE_UPDATE", () => {
    const poll = {
      question: "Pizza?", multi: false, anonymous: false, ended: false, total_voters: 2, my_votes: [0],
      options: [{ text: "Yes", count: 2 }, { text: "No", count: 0 }],
    };
    let s = setMentions(loaded(), { items: [], unread_count: 0 }, false);
    s = applyEvent(s, "MESSAGE_CREATE", msg("500", { mentions: ["20"], poll }));
    s = applyEvent(s, "MESSAGE_UPDATE", msg("500", { poll: { ...poll, total_voters: 3, my_votes: [] } }));
    expect(s.mentions.items[0].message.poll).toMatchObject({ my_votes: [0], total_voters: 3 });
  });

  it("masks sending in a webhook channel, but not in its threads", () => {
    const alerts = { id: "102", type: "webhook" as const, name: "alerts", position: 1, topic: "", overrides: [] };
    let s = applyEvent(applyReady(initialState, ready()), "CHANNEL_CREATE", alerts);
    expect(myChannelPerms(s, "102")).toBe(Perm.ViewChannel);
    expect(myThreadPerms(s, "102")).toBe(Perm.ViewChannel | Perm.SendMessages);
    expect(myChannelPerms(s, "101")).toBe(Perm.ViewChannel | Perm.SendMessages);
    // The owner too: everything but sending and attaching.
    s = applyEvent(applyReady(initialState, ready({ server: { ...ready().server!, owner_id: "20" } })), "CHANNEL_CREATE", alerts);
    expect(myChannelPerms(s, "102")).toBe(ALL_PERMS & ~WEBHOOK_MASKED);
    expect(hasPerm(myChannelPerms(s, "102"), Perm.ManageWebhooks)).toBe(true);
    expect(myThreadPerms(s, "102")).toBe(ALL_PERMS);
  });

  it("takes a webhook message, which has no author", () => {
    let s = setMentions(loaded(), { items: [], unread_count: 0 }, false);
    s = applyEvent(s, "MESSAGE_CREATE", msg("30", { author: undefined, webhook: { id: "7", name: "CI" }, mentions: ["20"] }));
    expect(s.messages["101"].items.at(-1)).toMatchObject({ id: "30", webhook: { name: "CI" } });
    expect(s.readStates["101"]).toMatchObject({ lastMessageId: "30", lastReadId: undefined });
    expect(s.mentions.items.map((i) => i.message.id)).toEqual(["30"]);
  });
});

describe("reactions and emoji", () => {
  const msg = { id: "500", channel_id: "101", author: { id: "10", username: "alice", display_name: "Alice", custom_status: "" },
    content: "hi", attachments: [], created_at: "", deleted: false, mentions: [], reactions: [] };

  it("adds and removes reactions", () => {
    let s = applyReady(initialState, ready());
    s = { ...s, messages: { "101": { items: [msg as never], hasMore: false } } };
    s = applyEvent(s, "MESSAGE_REACTION_ADD", { channel_id: "101", message_id: "500", emoji: "\u{1F44D}", user_id: "20" });
    s = applyEvent(s, "MESSAGE_REACTION_ADD", { channel_id: "101", message_id: "500", emoji: "\u{1F44D}", user_id: "10" });
    s = applyEvent(s, "MESSAGE_REACTION_ADD", { channel_id: "101", message_id: "500", emoji: "\u{1F44D}", user_id: "10" }); // repeat
    expect(s.messages["101"].items[0].reactions).toEqual([{ emoji: "\u{1F44D}", count: 2, user_ids: ["20", "10"] }]);
    s = applyEvent(s, "MESSAGE_REACTION_REMOVE", { channel_id: "101", message_id: "500", emoji: "\u{1F44D}", user_id: "20" });
    s = applyEvent(s, "MESSAGE_REACTION_REMOVE", { channel_id: "101", message_id: "500", emoji: "\u{1F44D}", user_id: "10" });
    expect(s.messages["101"].items[0].reactions).toEqual([]);
  });

  it("keeps the emoji list from READY and EMOJI_UPDATE", () => {
    let s = applyReady(initialState, ready({ emoji: [{ id: "7", name: "parrot", url: "/api/emoji/7" }] }));
    expect(emojiList(s).map((e) => e.name)).toEqual(["parrot"]);
    s = applyEvent(s, "EMOJI_UPDATE", { emoji: [{ id: "8", name: "zebra", url: "/api/emoji/8" }, { id: "9", name: "apple", url: "/api/emoji/9" }] });
    expect(emojiList(s).map((e) => e.name)).toEqual(["apple", "zebra"]);
    expect(customEmojiId("custom:8")).toBe("8");
    expect(customEmojiId("\u{1F44D}")).toBeNull();
  });

  it("keeps the quote in replies current when the original is edited or deleted", () => {
    let s = applyReady(initialState, ready());
    const reply = { ...msg, id: "501", content: "agreed", reply_to: { id: "500", author: msg.author, content: "hi", deleted: false } };
    s = { ...s, messages: { "101": { items: [msg as never, reply as never], hasMore: false } } };
    s = applyEvent(s, "MESSAGE_UPDATE", { ...msg, content: "x".repeat(250) });
    expect(s.messages["101"].items[1].reply_to).toMatchObject({ content: "x".repeat(200), deleted: false });
    s = applyEvent(s, "MESSAGE_DELETE", { id: "500", channel_id: "101" });
    expect(s.messages["101"].items[1].reply_to).toMatchObject({ id: "500", content: "", deleted: true });
    expect(s.messages["101"].items[1].content).toBe("agreed");
  });

  it("keeps reactions from reaction events on MESSAGE_UPDATE", () => {
    let s = applyReady(initialState, ready());
    s = { ...s, messages: { "101": { items: [msg as never], hasMore: false } } };
    s = applyEvent(s, "MESSAGE_REACTION_ADD", { channel_id: "101", message_id: "500", emoji: "\u{1F44D}", user_id: "20" });
    s = applyEvent(s, "MESSAGE_UPDATE", { ...msg, content: "edited", reactions: [] }); // hydrated before the reaction
    expect(s.messages["101"].items[0]).toMatchObject({ content: "edited", reactions: [{ emoji: "\u{1F44D}", count: 1, user_ids: ["20"] }] });
  });

  it("does not let a late POST echo overwrite newer gateway state", () => {
    let s = applyReady(initialState, ready());
    s = addPending(s, "101", "n1", "see https://example.com");
    const sent = { ...msg, author: bob, content: "see https://example.com", nonce: "n1" };
    s = applyEvent(s, "MESSAGE_CREATE", sent);
    const embed = { url: "https://example.com", site: "", title: "Example", description: "" };
    s = applyEvent(s, "MESSAGE_UPDATE", { ...sent, embed });
    s = applyEvent(s, "MESSAGE_CREATE", sent); // the POST response
    expect(s.messages["101"].items).toHaveLength(1);
    expect(s.messages["101"].items[0].embed).toEqual(embed);
  });

  it("shows a pending reply with its reference", () => {
    let s = applyReady(initialState, ready());
    s = addPending(s, "101", "n1", "agreed", [], { id: "500", author: msg.author, content: "hi", deleted: false });
    expect(s.messages["101"].items[0].reply_to?.id).toBe("500");
  });
});

describe("organisation", () => {
  const withCategories = () => {
    const r = ready();
    r.server!.categories = [{ id: "902", name: "Voice", position: 1 }, { id: "901", name: "Text", position: 0 }, { id: "903", name: "Empty", position: 2 }];
    r.server!.channels = [
      { id: "100", type: "welcome", name: "welcome", position: -1, topic: "", overrides: [], tags: [], require_tag: false },
      { id: "101", type: "text", name: "general", position: 0, topic: "", overrides: [], tags: [], require_tag: false },
      { id: "102", type: "text", name: "b", position: 1, topic: "", category_id: "901", overrides: [], tags: [], require_tag: false },
      { id: "103", type: "text", name: "a", position: 0, topic: "", category_id: "901", overrides: [], tags: [], require_tag: false },
      { id: "104", type: "voice", name: "lounge", position: 0, topic: "", category_id: "902", overrides: [], tags: [], require_tag: false },
    ];
    return applyReady(initialState, r);
  };

  it("groups channels by category", () => {
    const g = channelGroups(withCategories());
    expect(g.uncategorised).toEqual(["100", "101"]);
    expect(g.categories.map((c) => [c.category.id, c.channelIds])).toEqual([["901", ["103", "102"]], ["902", ["104"]], ["903", []]]);
  });

  it("lists channels in sidebar order", () => {
    expect(sidebarChannelIds(withCategories())).toEqual(["100", "101", "103", "102", "104"]);
  });

  it("CATEGORY_DELETE clears category_id on its channels", () => {
    const s = applyEvent(withCategories(), "CATEGORY_DELETE", { id: "901" });
    expect(s.server!.categories["901"]).toBeUndefined();
    expect(s.channels["102"].category_id).toBeUndefined();
    expect(s.channels["104"].category_id).toBe("902");
  });

  it("CATEGORY_CREATE and CATEGORY_UPDATE keep categories current", () => {
    let s = applyEvent(withCategories(), "CATEGORY_CREATE", { id: "904", name: "New", position: 3 });
    s = applyEvent(s, "CATEGORY_UPDATE", { id: "904", name: "Renamed", position: 3 });
    expect(s.server!.categories["904"].name).toBe("Renamed");
  });

  it("keeps thread channels out of channelIds", () => {
    const s0 = applyReady(initialState, ready());
    const t = { id: "300", type: "thread" as const, name: "t", position: 0, topic: "", parent_channel_id: "101", parent_message_id: "20", overrides: [], tags: [], require_tag: false };
    const s = applyEvent(s0, "CHANNEL_CREATE", t);
    expect(s.channels["300"]).toBeDefined();
    expect(s.server!.channelIds).toEqual(s0.server!.channelIds);
    expect(applyEvent(s, "CHANNEL_UPDATE", { ...t, name: "x" }).server!.channelIds).toEqual(s0.server!.channelIds);
  });

  it("THREAD_UPDATE sets thread on a loaded parent message and ignores unloaded channels", () => {
    const thread = { id: "300", name: "t", message_count: 4, participants: [] };
    const s = applyEvent(loaded(), "THREAD_UPDATE", { channel_id: "101", message_id: "10", thread });
    expect(s.messages["101"].items.find((m) => m.id === "10")?.thread?.message_count).toBe(4);
    expect(applyEvent(s, "THREAD_UPDATE", { channel_id: "999", message_id: "10", thread }).messages["999"]).toBeUndefined();
  });

  it("deleting a channel removes its threads", () => {
    let s = loaded();
    const t = { id: "300", type: "thread" as const, name: "t", position: 0, topic: "", parent_channel_id: "101", parent_message_id: "10", overrides: [], tags: [], require_tag: false };
    s = applyEvent(s, "CHANNEL_CREATE", t);
    s = prependHistory(s, "300", [msg("31", { channel_id: "300" })], 50);
    s = applyEvent(s, "CHANNEL_DELETE", { id: "101" });
    expect(s.channels["300"]).toBeUndefined();
    expect(s.messages["300"]).toBeUndefined();
  });

  it("thread channel updates and deletes patch the parent message summary", () => {
    let s = loaded();
    const thread = { id: "300", name: "t", message_count: 1, participants: [] };
    s = applyEvent(s, "THREAD_UPDATE", { channel_id: "101", message_id: "10", thread });
    const t = { id: "300", type: "thread" as const, name: "t", position: 0, topic: "", parent_channel_id: "101", parent_message_id: "10", overrides: [], tags: [], require_tag: false };
    s = applyEvent(s, "CHANNEL_CREATE", t);
    s = applyEvent(s, "CHANNEL_UPDATE", { ...t, name: "renamed" });
    expect(s.messages["101"].items.find((m) => m.id === "10")?.thread?.name).toBe("renamed");
    s = applyEvent(s, "CHANNEL_DELETE", { id: "300" });
    expect(s.messages["101"].items.find((m) => m.id === "10")?.thread).toBeUndefined();
  });

  it("deleting a thread that was never loaded drops its summary", () => {
    let s = loaded();
    s = applyEvent(s, "THREAD_UPDATE", { channel_id: "101", message_id: "10", thread: { id: "300", name: "t", message_count: 1, participants: [] } });
    expect(s.channels["300"]).toBeUndefined();
    s = applyEvent(s, "CHANNEL_DELETE", { id: "300" });
    expect(s.messages["101"].items.find((m) => m.id === "10")?.thread).toBeUndefined();
  });
});

describe("sounds", () => {
  it("keeps the soundboard from READY and SOUND_UPDATE", () => {
    const snd = (id: string, name: string) => ({ id, name, emoji: "\u{1F514}", duration_ms: 1000, url: `/api/sounds/${id}` });
    let s = applyReady(initialState, ready({ sounds: [snd("2", "zap"), snd("1", "airhorn")] }));
    expect(soundList(s).map((x) => x.name)).toEqual(["airhorn", "zap"]);
    s = applyEvent(s, "SOUND_UPDATE", { sounds: [snd("3", "bell")] });
    expect(soundList(s).map((x) => x.name)).toEqual(["bell"]);
    s = applyEvent(s, "SOUND_UPDATE", { sounds: null });
    expect(s.sounds).toEqual({});
  });

  it("finds users anywhere and clears omitted profile fields on USER_UPDATE", () => {
    let s = loaded();
    s = applyEvent(s, "USER_UPDATE", { id: "20", username: "bob", display_name: "Bob", custom_status: "", pronouns: "he/him", avatar_url: "/api/avatars/20?v=abc" });
    expect(findUser(s, "20")).toMatchObject({ pronouns: "he/him", avatar_url: "/api/avatars/20?v=abc" });
    expect(s.me?.avatar_url).toBe("/api/avatars/20?v=abc");
    s = applyEvent(s, "USER_UPDATE", { id: "20", username: "bob", display_name: "Bob", custom_status: "" });
    expect(findUser(s, "20")?.avatar_url).toBeUndefined();
    expect(findUser(s, "20")?.pronouns).toBeUndefined();
    expect(s.me?.avatar_url).toBeUndefined();
    expect(findUser(s, "999")).toBeUndefined();
  });

  it("carries links and banner on USER_UPDATE and clears them when omitted", () => {
    let s = loaded();
    const base = { id: "20", username: "bob", display_name: "Bob", custom_status: "" };
    s = applyEvent(s, "USER_UPDATE", { ...base, links: ["https://github.com/bob"], banner_url: "/api/banners/20?v=abc" });
    expect(findUser(s, "20")).toMatchObject({ links: ["https://github.com/bob"], banner_url: "/api/banners/20?v=abc" });
    expect(s.me?.links).toEqual(["https://github.com/bob"]);
    expect(s.me?.banner_url).toBe("/api/banners/20?v=abc");
    s = applyEvent(s, "USER_UPDATE", base);
    expect(findUser(s, "20")?.links).toBeUndefined();
    expect(findUser(s, "20")?.banner_url).toBeUndefined();
    expect(s.me?.links).toBeUndefined();
    expect(s.me?.banner_url).toBeUndefined();
  });

  it("finds a DM participant and my 1:1 DM", () => {
    const meUser = { id: "20", username: "bob", display_name: "Bob", custom_status: "" };
    const carol = { id: "30", username: "carol", display_name: "Carol", custom_status: "" };
    const s = applyReady(initialState, ready({
      dms: [
        { id: "500", type: "dm", name: "", position: 0, topic: "", overrides: [], tags: [], require_tag: false, participants: [meUser, carol, bob] },
        { id: "501", type: "dm", name: "", position: 0, topic: "", overrides: [], tags: [], require_tag: false, participants: [meUser, carol] },
      ],
    }));
    expect(findUser(s, "30")?.display_name).toBe("Carol");
    expect(findDM(s, "30")).toBe("501");
    expect(findDM(s, "2")).toBeUndefined(); // only a group DM with bob
  });

  it("opens a window around a message and ignores new messages until it reaches the present", () => {
    let s = loaded(); // channel 101 has 10 and 20; READY says its last message is 25
    s = replaceWindow(s, "101", [msg("6"), msg("5"), msg("4")]);
    expect(s.messages["101"].items.map((m) => m.id)).toEqual(["4", "5", "6"]);
    expect(s.messages["101"].hasNewer).toBe(true);
    s = applyEvent(s, "MESSAGE_CREATE", msg("30"));
    expect(s.messages["101"].items.map((m) => m.id)).toEqual(["4", "5", "6"]);
    expect(s.readStates["101"].lastMessageId).toBe("30");
    s = appendNewer(s, "101", [msg("30"), msg("7")]);
    expect(s.messages["101"].items.map((m) => m.id)).toEqual(["4", "5", "6", "7", "30"]);
    expect(s.messages["101"].hasNewer).toBe(false);
    s = latestWindow(s, "101", [msg("30"), msg("29")], 50);
    expect(s.messages["101"]).toMatchObject({ hasMore: false, hasNewer: false });
    expect(s.messages["101"].items.map((m) => m.id)).toEqual(["29", "30"]);
  });

  it("keeps the mentions inbox and its unread count live", () => {
    const meMention = (id: string, extra: Partial<Message> = {}) => msg(id, { mentions: ["20"], ...extra });
    let s = setMentions(loaded(), { items: [], unread_count: 2 }, false);
    expect(s.mentions).toMatchObject({ loaded: true, unread: 2, hasMore: false });
    s = applyEvent(s, "MESSAGE_CREATE", meMention("40"));
    expect(s.mentions.items.map((i) => i.message.id)).toEqual(["40"]);
    expect(s.mentions.items[0]).toMatchObject({ unread: true, channel: { id: "101", type: "text", name: "general" } });
    expect(s.mentions.unread).toBe(3);
    s = applyEvent(s, "MESSAGE_CREATE", meMention("41", { author: { id: "20", username: "bob", display_name: "Bob", custom_status: "" } }));
    expect(s.mentions.items).toHaveLength(1); // my own message
    s = ackLocal(s, "101", "40");
    expect(s.mentions.items[0].unread).toBe(false);
    expect(s.mentions.unread).toBe(2);
    s = applyEvent(s, "MESSAGE_DELETE", { id: "40", channel_id: "101" });
    expect(s.mentions.items).toHaveLength(0);
    expect(s.mentions.unread).toBe(2); // it was already read
    s = markMentionsRead(s, [{ channel_id: "101", last_read_id: "45" }]);
    expect(s.mentions.unread).toBe(0);
    expect(s.readStates["101"].lastReadId).toBe("45");
  });

  it("applies a mentions ack without moving a read position back", () => {
    let s = loaded();
    s = ackLocal(s, "101", "50");
    s = markMentionsRead(s, [{ channel_id: "101", last_read_id: "45" }]);
    expect(s.readStates["101"].lastReadId).toBe("50");
  });

  it("keeps a detached window detached when older history is added", () => {
    let s = replaceWindow(loaded(), "101", [msg("6"), msg("5")]);
    s = prependHistory(s, "101", [msg("4"), msg("3")], 50);
    expect(s.messages["101"].hasNewer).toBe(true);
    expect(s.messages["101"].items.map((m) => m.id)).toEqual(["3", "4", "5", "6"]);
  });

  it("still resolves my pending message in a detached window", () => {
    let s = replaceWindow(loaded(), "101", [msg("6"), msg("5")]);
    s = addPending(s, "101", "n1", "hello");
    s = applyEvent(s, "MESSAGE_CREATE", msg("31", { nonce: "n1", author: { id: "20", username: "bob", display_name: "Bob", custom_status: "" } }));
    expect(s.messages["101"].items.some((m) => m.pending)).toBe(false);
    s = applyEvent(s, "MESSAGE_CREATE", msg("32"));
    expect(s.messages["101"].items.map((m) => m.id)).not.toContain("32");
  });
});

describe("forum posts", () => {
  const forum = { id: "400", type: "forum" as const, name: "ideas", position: 2, topic: "", overrides: [], tags: ["bug"], require_tag: false };
  const post = (id: string, title: string) => ({
    channel: { id, type: "thread" as const, name: title, position: 0, topic: "", parent_channel_id: "400", overrides: [], tags: [], require_tag: false },
    summary: { id, name: title, message_count: 1, participants: [] },
  });
  // A forum whose post list has been loaded (empty).
  const withForum = (): State => {
    const s = applyEvent(loaded(), "CHANNEL_CREATE", forum);
    return { ...s, posts: { ...s.posts, "400": [] } };
  };

  it("POST_UPDATE adds a post, then replaces it in place", () => {
    let s = withForum();
    s = applyEvent(s, "POST_UPDATE", { channel_id: "400", post: post("500", "one") });
    s = applyEvent(s, "POST_UPDATE", { channel_id: "400", post: post("501", "two") });
    s = applyEvent(s, "POST_UPDATE", { channel_id: "400", post: post("500", "one!") });
    expect(s.posts["400"]?.map((p) => p.channel.name)).toEqual(["one!", "two"]);
  });

  it("POST_DELETE removes the post and its channel and messages", () => {
    let s = applyEvent(withForum(), "POST_UPDATE", { channel_id: "400", post: post("500", "one") });
    s = applyEvent(s, "CHANNEL_CREATE", post("500", "one").channel);
    s = prependHistory(s, "500", [msg("31", { channel_id: "500" })], 50);
    s = applyEvent(s, "POST_DELETE", { channel_id: "400", id: "500" });
    expect(s.posts["400"]).toEqual([]);
    expect(s.channels["500"]).toBeUndefined();
    expect(s.messages["500"]).toBeUndefined();
  });

  it("POST_UPDATE and POST_DELETE leave a forum whose posts are not loaded alone", () => {
    let s = applyEvent(loaded(), "CHANNEL_CREATE", forum);
    s = applyEvent(s, "POST_UPDATE", { channel_id: "400", post: post("500", "one") });
    expect(s.posts["400"]).toBeUndefined();
    s = applyEvent(s, "CHANNEL_CREATE", post("500", "one").channel);
    s = applyEvent(s, "POST_DELETE", { channel_id: "400", id: "500" });
    expect(s.posts["400"]).toBeUndefined();
    expect(s.channels["500"]).toBeUndefined();
  });

  it("CHANNEL_UPDATE of a forum drops tags it no longer offers from its posts and respells the rest", () => {
    const tagged = (id: string, tags: string[]) => ({ ...post(id, id), channel: { ...post(id, id).channel, tags } });
    let s = applyEvent(withForum(), "POST_UPDATE", { channel_id: "400", post: tagged("500", ["bug", "idea"]) });
    s = applyEvent(s, "CHANNEL_UPDATE", { ...forum, tags: ["Bug"] });
    expect(s.posts["400"]?.[0].channel.tags).toEqual(["Bug"]);
  });

  it("deleting the forum drops its posts", () => {
    let s = applyEvent(withForum(), "POST_UPDATE", { channel_id: "400", post: post("500", "one") });
    s = applyEvent(s, "CHANNEL_DELETE", { id: "400" });
    expect(s.posts["400"]).toBeUndefined();
  });

  const withLast = (id: string, last: string, author?: { id: string }) => ({
    ...post(id, id),
    ...(author ? { author } : {}),
    first_message_id: id === "500" ? "40" : undefined,
    summary: { ...post(id, id).summary, last_message_id: last },
  });

  it("POST_UPDATE moves the forum's newest message forward, even when its posts are not loaded", () => {
    let s = applyEvent(loaded(), "CHANNEL_CREATE", forum);
    s = applyEvent(s, "POST_UPDATE", { channel_id: "400", post: withLast("500", "40") });
    expect(s.readStates["400"]).toEqual({ lastMessageId: "40" });
    s = applyEvent(s, "POST_UPDATE", { channel_id: "400", post: withLast("501", "120") });
    s = applyEvent(s, "POST_UPDATE", { channel_id: "400", post: withLast("500", "99") }); // older: kept
    expect(s.readStates["400"]).toEqual({ lastMessageId: "120" });
  });

  it("POST_UPDATE for my own message keeps the forum read", () => {
    let s = applyEvent(withForum(), "POST_UPDATE", { channel_id: "400", post: withLast("500", "40", me) }); // my new post
    expect(s.readStates["400"]).toEqual({ lastMessageId: "40", lastReadId: "40" });
    s = applyEvent(s, "MESSAGE_CREATE", msg("130", { channel_id: "501", author: me })); // my reply, post not loaded
    expect(s.messages["501"]).toBeUndefined();
    s = applyEvent(s, "POST_UPDATE", { channel_id: "400", post: withLast("501", "130") });
    expect(s.readStates["400"]).toEqual({ lastMessageId: "130", lastReadId: "130" });
    s = applyEvent(s, "MESSAGE_CREATE", msg("140", { channel_id: "501" })); // bob's reply
    s = applyEvent(s, "POST_UPDATE", { channel_id: "400", post: withLast("501", "140") });
    expect(s.readStates["400"]).toEqual({ lastMessageId: "140", lastReadId: "130" });
  });
});

describe("activities", () => {
  it("come from READY and follow ACTIVITY_UPDATE", () => {
    const spotify = { user_id: "2", type: "listening", platform: "spotify", title: "Song", url: "https://open.spotify.com/track/x" } as const;
    let s = applyReady(initialState, ready({ activities: [spotify] }));
    expect(s.activities["2"]?.title).toBe("Song");
    s = applyEvent(s, "ACTIVITY_UPDATE", { user_id: "2", activity: { ...spotify, title: "Next" } });
    expect(s.activities["2"]?.title).toBe("Next");
    s = applyEvent(s, "ACTIVITY_UPDATE", { user_id: "2", activity: null as never });
    expect(s.activities["2"]).toBeUndefined();
  });
});

describe("music playlists", () => {
  const pl = { id: "7", title: "Mix", count: 2, duration: 300, created_at: "2026-10-11T00:00:00Z" };
  it("ignore events until loaded, then follow updates and deletes", () => {
    let s = applyEvent(initialState, "MUSIC_PLAYLIST_UPDATE", pl);
    expect(s.playlists).toBeNull();
    s = { ...s, playlists: {} };
    s = applyEvent(s, "MUSIC_PLAYLIST_UPDATE", pl);
    expect(s.playlists?.["7"]?.title).toBe("Mix");
    s = applyEvent(s, "MUSIC_PLAYLIST_UPDATE", { ...pl, title: "Road trip" });
    expect(s.playlists?.["7"]?.title).toBe("Road trip");
    s = applyEvent(s, "MUSIC_PLAYLIST_DELETE", { id: "7" });
    expect(s.playlists).toEqual({});
  });
});
