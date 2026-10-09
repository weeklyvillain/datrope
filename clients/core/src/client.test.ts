import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { DatropeClient } from "./client";
import { applyReady, prependHistory } from "./store";
import { Perm } from "./perms";
import type { Attachment, Message, Ready } from "./types";

const BASE = "http://test.local";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ready = {
  session_id: "s", dms: [], presences: [], read_states: [], voice_states: [], emoji: [], sounds: [],
  user: { id: "1", username: "alice", display_name: "Alice", custom_status: "", is_admin: false, disabled: false, created_at: "2026-01-01T00:00:00Z" },
} satisfies Ready;

const attachment: Attachment = {
  id: "900", channel_id: "300", filename: "hi.txt", content_type: "text/plain; charset=utf-8",
  size: 2, inline: false, url: "/api/attachments/900",
};

function message(body: { content: string; nonce: string }, attachments: Attachment[] = []): Message {
  return {
    id: "77", channel_id: "300", author: { id: "1", username: "alice", display_name: "Alice", custom_status: "" },
    content: body.content, created_at: "2026-01-01T00:00:00Z", deleted: false, pinned: false, nonce: body.nonce, attachments, mentions: [], reactions: [],
  };
}

function readyClient() {
  const client = new DatropeClient({ baseUrl: BASE, wsUrl: "ws://unused" });
  client.store.setState(prependHistory(applyReady(client.store.getState(), ready), "300", [], 50), true);
  return client;
}

it("sends optimistically and confirms with the server's message", async () => {
  server.use(http.post(`${BASE}/api/channels/:id/messages`, async ({ request }) => {
    const body = (await request.json()) as { content: string; nonce: string };
    return HttpResponse.json(message(body), { status: 201 });
  }));
  const client = readyClient();
  await client.send("300", "hi");
  const items = client.store.getState().messages["300"].items;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ id: "77", content: "hi" });
  expect(items[0].pending).toBeUndefined();
});

it("uploads a file and sends it with a message", async () => {
  let csrf: string | null = null;
  let channel: string | null = null;
  let filename: string | undefined;
  let sent: unknown;
  server.use(
    http.post(`${BASE}/api/attachments`, async ({ request }) => {
      csrf = request.headers.get("X-Datrope-CSRF");
      channel = new URL(request.url).searchParams.get("channel_id");
      filename = ((await request.formData()).get("file") as File).name;
      return HttpResponse.json(attachment, { status: 201 });
    }),
    http.post(`${BASE}/api/channels/:id/messages`, async ({ request }) => {
      const body = (await request.json()) as { content: string; nonce: string };
      sent = body;
      return HttpResponse.json(message(body, [attachment]), { status: 201 });
    }),
  );
  const client = readyClient();
  const a = await client.upload("300", new Blob(["hi"]), "hi.txt");
  expect(a.id).toBe("900");
  expect(csrf).toBe("1");
  expect(channel).toBe("300");
  expect(filename).toBe("hi.txt");

  await client.send("300", "", [a]);
  expect(sent).toMatchObject({ content: "", attachment_ids: ["900"] });
  expect(client.store.getState().messages["300"].items[0].attachments).toEqual([attachment]);
  expect(client.url(a.url)).toBe(`${BASE}/api/attachments/900`);
});

it("reports upload errors with the server's code", async () => {
  server.use(http.post(`${BASE}/api/attachments`, () =>
    HttpResponse.json({ code: "TOO_LARGE", message: "files can be at most 1048576 bytes" }, { status: 413 })));
  const err = await readyClient().upload("300", new Blob(["x"]), "x.bin").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe("TOO_LARGE");
  expect((err as ApiError).status).toBe(413);
});

it("shows attachments on the pending message", async () => {
  let release!: () => void;
  server.use(http.post(`${BASE}/api/channels/:id/messages`, async ({ request }) => {
    const body = (await request.json()) as { content: string; nonce: string };
    await new Promise<void>((r) => (release = r));
    return HttpResponse.json(message(body, [attachment]), { status: 201 });
  }));
  const client = readyClient();
  const sending = client.send("300", "look", [attachment]);
  await expect.poll(() => client.store.getState().messages["300"].items[0]?.attachments).toEqual([attachment]);
  expect(client.store.getState().messages["300"].items[0].pending).toBe(true);
  await expect.poll(() => typeof release).toBe("function"); // the request reached the server
  release();
  await sending;
});

it("joins voice, reports its own state and moderates", async () => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const record = async ({ request }: { request: Request }) => {
    const text = await request.text();
    calls.push({ method: request.method, path: new URL(request.url).pathname, body: text ? JSON.parse(text) : undefined });
  };
  server.use(
    http.post(`${BASE}/api/voice/:id/join`, async (info) => {
      await record(info);
      return HttpResponse.json({ url: "wss://lk.test", token: "tok" });
    }),
    http.patch(`${BASE}/api/voice/state`, async (info) => { await record(info); return new HttpResponse(null, { status: 204 }); }),
    http.post(`${BASE}/api/voice/members/:id/mute`, async (info) => { await record(info); return new HttpResponse(null, { status: 204 }); }),
    http.post(`${BASE}/api/voice/members/:id/move`, async (info) => { await record(info); return new HttpResponse(null, { status: 204 }); }),
    http.delete(`${BASE}/api/voice/members/:id`, async (info) => { await record(info); return new HttpResponse(null, { status: 204 }); }),
  );
  const client = readyClient();
  expect(await client.joinVoice("301", { self_mute: true, self_deaf: false })).toEqual({ url: "wss://lk.test", token: "tok" });
  await client.setVoiceSelf({ self_deaf: true });
  await client.serverMute("2", true);
  await client.moveVoice("2", "302");
  await client.disconnectVoice("2");
  expect(calls).toEqual([
    { method: "POST", path: "/api/voice/301/join", body: { self_mute: true, self_deaf: false } },
    { method: "PATCH", path: "/api/voice/state", body: { self_deaf: true } },
    { method: "POST", path: "/api/voice/members/2/mute", body: { muted: true } },
    { method: "POST", path: "/api/voice/members/2/move", body: { channel_id: "302" } },
    { method: "DELETE", path: "/api/voice/members/2", body: undefined },
  ]);
});

it("maps VOICE_UNAVAILABLE to an ApiError", async () => {
  server.use(http.post(`${BASE}/api/voice/:id/join`, () =>
    HttpResponse.json({ code: "VOICE_UNAVAILABLE", message: "the voice server is unreachable" }, { status: 503 })));
  const err = await readyClient().joinVoice("301", { self_mute: false, self_deaf: false }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe("VOICE_UNAVAILABLE");
});

it("tells listeners about every applied event", () => {
  const client = readyClient();
  const seen: string[] = [];
  const off = client.onEvent((type) => seen.push(type));
  client.apply("VOICE_MOVE", { channel_id: "302" });
  off();
  client.apply("VOICE_MOVE", { channel_id: "303" });
  expect(seen).toEqual(["VOICE_MOVE"]);
});

it("keeps applying when a listener throws", () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const client = readyClient();
  const seen: string[] = [];
  client.onEvent(() => { throw new Error("boom"); });
  client.onEvent((type) => seen.push(type));
  const voice = { user_id: "2", channel_id: "301", self_mute: false, self_deaf: false, server_mute: false, camera: false, screen: false };
  expect(() => client.apply("VOICE_STATE_UPDATE", voice)).not.toThrow();
  expect(client.store.getState().voice["2"]).toEqual(voice);
  expect(seen).toEqual(["VOICE_STATE_UPDATE"]);
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});

const sv = { id: "1", name: "Datrope", description: "", palette: "emerald", owner_id: "10", created_at: "", rules_gate: false } as const;
const member = (accepted: boolean) => ({
  user: { id: "1", username: "alice", display_name: "Alice", custom_status: "" }, role_ids: [], joined_at: "",
  ...(accepted ? { accepted_rules_at: "x" } : {}),
});
const serverReady = (over: { rules_gate?: boolean; accepted?: boolean } = {}): Ready => ({
  ...ready,
  server: {
    ...sv, rules_gate: over.rules_gate ?? false,
    roles: [{ id: "1", name: "@everyone", permissions: Perm.ViewChannel, position: 0, hoist: false }],
    members: [member(over.accepted ?? true)],
    categories: [],
    channels: [{ id: "100", type: "welcome", name: "welcome", position: -1, topic: "", overrides: [] }],
  },
});

/** A client whose WebSocket factory records every connection it opens. */
function socketClient(r: Ready) {
  const sockets: unknown[] = [];
  class FakeSocket {
    readyState = 0;
    constructor() { sockets.push(this); }
    send() {}
    close() {}
  }
  const client = new DatropeClient({ baseUrl: BASE, wsUrl: "ws://unused", WebSocket: FakeSocket as unknown as typeof WebSocket });
  client.store.setState(applyReady(client.store.getState(), r), true);
  client.connect();
  return { client, sockets };
}

it("loads channels from the one server", async () => {
  server.use(http.get(`${BASE}/api/server/channels`, () => HttpResponse.json([
    { id: "100", type: "welcome", name: "welcome", position: -1, overrides: [] },
    { id: "101", type: "text", name: "general", position: 0, overrides: [] },
  ])));
  const { client } = socketClient(serverReady());
  await client.loadChannels();
  expect(client.store.getState().server?.channelIds).toEqual(["100", "101"]);
});

it("reloads channels once for a burst of role and member events", async () => {
  let gets = 0;
  server.use(http.get(`${BASE}/api/server/channels`, () => {
    gets++;
    return HttpResponse.json([{ id: "100", type: "welcome", name: "welcome", position: -1, overrides: [] }]);
  }));
  const { client } = socketClient(serverReady());
  const role = { id: "2", name: "Mods", permissions: 0, position: 1, hoist: false };
  client.apply("ROLE_UPDATE", role);
  client.apply("ROLE_UPDATE", { ...role, name: "Moderators" });
  client.apply("MEMBER_UPDATE", member(true));
  client.apply("ROLE_DELETE", { id: "2" });
  await vi.waitFor(() => expect(gets).toBe(1));
  await new Promise((r) => setTimeout(r, 100));
  expect(gets).toBe(1);
});

it("accepting the rules reconnects for a full READY", async () => {
  let posted = false;
  server.use(http.post(`${BASE}/api/server/welcome/accept`, () => { posted = true; return new HttpResponse(null, { status: 204 }); }));
  const { client, sockets } = socketClient(serverReady({ rules_gate: true, accepted: false }));
  expect(sockets).toHaveLength(1);
  await client.acceptRules();
  expect(posted).toBe(true);
  expect(sockets).toHaveLength(2);
});

it("joining with an invite accepts it, then reconnects", async () => {
  let code: string | undefined;
  server.use(http.post(`${BASE}/api/invites/:code/accept`, ({ params }) => { code = String(params.code); return new HttpResponse(null, { status: 204 }); }));
  const { client, sockets } = socketClient(ready);
  await client.joinServer("abc");
  expect(code).toBe("abc");
  expect(sockets).toHaveLength(2);
});

it("reconnects when a gated client sees the gate switched off", () => {
  const { client, sockets } = socketClient(serverReady({ rules_gate: true, accepted: false }));
  client.apply("SERVER_UPDATE", { ...sv, rules_gate: false });
  expect(sockets).toHaveLength(2);
});

it("does not reconnect on SERVER_UPDATE when not gated", () => {
  const { client, sockets } = socketClient(serverReady({ rules_gate: true, accepted: true }));
  client.apply("SERVER_UPDATE", { ...sv, rules_gate: false, name: "Other" });
  expect(sockets).toHaveLength(1);
});

it("reconnects when another tab accepts the rules for me", () => {
  const { client, sockets } = socketClient(serverReady({ rules_gate: true, accepted: false }));
  client.apply("MEMBER_UPDATE", member(true));
  expect(sockets).toHaveLength(2);
});

it("uploads and deletes server images", async () => {
  const calls: { method: string; path: string; field?: string }[] = [];
  server.use(
    http.put(`${BASE}/api/server/icon`, async ({ request }) => {
      calls.push({ method: "PUT", path: "icon", field: ((await request.formData()).get("file") as File).name });
      return HttpResponse.json({ url: "/api/server/icon" });
    }),
    http.post(`${BASE}/api/server/images`, async ({ request }) => {
      calls.push({ method: "POST", path: "images", field: ((await request.formData()).get("file") as File).name });
      return HttpResponse.json({ url: "/img/1", id: "5" }, { status: 201 });
    }),
    http.delete(`${BASE}/api/server/banner`, ({ request }) => {
      calls.push({ method: request.method, path: "banner" });
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const { client } = socketClient(ready);
  expect(await client.uploadServerImage("icon", new Blob(["x"]))).toEqual({ url: "/api/server/icon" });
  expect(await client.uploadServerImage("page", new Blob(["x"]))).toEqual({ url: "/img/1", id: "5" });
  await client.deleteServerImage("banner");
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PUT icon", "POST images", "DELETE banner"]);
});

it("reacts with an encoded emoji path", async () => {
  let path = "";
  server.use(http.put(`${BASE}/api/channels/:id/messages/:mid/reactions/:emoji`, ({ request }) => {
    path = new URL(request.url).pathname;
    return new HttpResponse(null, { status: 204 });
  }));
  await readyClient().react("101", "500", "\u{1F44D}");
  expect(path).toBe("/api/channels/101/messages/500/reactions/%F0%9F%91%8D");
});

it("sends reply_to_id", async () => {
  let sent: { reply_to_id?: string } = {};
  server.use(http.post(`${BASE}/api/channels/:id/messages`, async ({ request }) => {
    const body = (await request.json()) as { content: string; nonce: string; reply_to_id?: string };
    sent = body;
    return HttpResponse.json(message(body), { status: 201 });
  }));
  const author = { id: "1", username: "alice", display_name: "Alice", custom_status: "" };
  await readyClient().send("300", "x", [], { id: "500", author, content: "hi", deleted: false });
  expect(sent.reply_to_id).toBe("500");
});

it("moveChannel clears the category with clear_category", async () => {
  let body: unknown;
  server.use(http.patch(`${BASE}/api/channels/:id`, async ({ request }) => {
    body = await request.json();
    return HttpResponse.json({ id: "5", type: "text", name: "x", position: 2, topic: "", overrides: [] });
  }));
  await readyClient().moveChannel("5", { categoryId: null, position: 2 });
  expect(body).toEqual({ clear_category: true, position: 2 });
});

it("pins with PUT", async () => {
  let call = "";
  server.use(http.put(`${BASE}/api/channels/:id/pins/:mid`, ({ request }) => {
    call = `PUT ${new URL(request.url).pathname}`;
    return new HttpResponse(null, { status: 204 });
  }));
  await readyClient().pin("1", "2");
  expect(call).toBe("PUT /api/channels/1/pins/2");
});

it("createThread stores the thread channel", async () => {
  server.use(http.post(`${BASE}/api/channels/:id/messages/:mid/thread`, () =>
    HttpResponse.json({ id: "800", type: "thread", name: "t", position: 0, topic: "", parent_channel_id: "300", parent_message_id: "77", overrides: [] }, { status: 201 })));
  const client = readyClient();
  const ch = await client.createThread("300", "77", "t");
  expect(ch.id).toBe("800");
  expect(client.store.getState().channels["800"]).toBeDefined();
});

it("plays a sound with POST /api/voice/soundboard", async () => {
  let body: unknown;
  server.use(http.post(`${BASE}/api/voice/soundboard`, async ({ request }) => {
    body = await request.json();
    return new HttpResponse(null, { status: 204 });
  }));
  await readyClient().playSound("9");
  expect(body).toEqual({ sound_id: "9" });
});

it("updates and deletes sounds", async () => {
  const calls: string[] = [];
  let patch: unknown;
  server.use(
    http.patch(`${BASE}/api/server/sounds/:id`, async ({ request, params }) => {
      calls.push(`PATCH ${params.id}`);
      patch = await request.json();
      return HttpResponse.json({ id: "5", name: "x", emoji: "\u{1F514}", duration_ms: 1 });
    }),
    http.delete(`${BASE}/api/server/sounds/:id`, ({ params }) => {
      calls.push(`DELETE ${params.id}`);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const c = readyClient();
  await c.updateSound("5", { name: "x" });
  await c.deleteSound("5");
  expect(patch).toEqual({ name: "x" });
  expect(calls).toEqual(["PATCH 5", "DELETE 5"]);
});

it("uploads a sound as multipart name, emoji, file", async () => {
  let fields: Record<string, unknown> = {};
  server.use(http.post(`${BASE}/api/server/sounds`, async ({ request }) => {
    const f = await request.formData();
    fields = { name: f.get("name"), emoji: f.get("emoji"), file: f.get("file") instanceof Blob };
    return HttpResponse.json({ id: "5", name: "bell", emoji: "\u{1F514}", duration_ms: 1 }, { status: 201 });
  }));
  const s = await readyClient().uploadSound("bell", "\u{1F514}", new Blob(["x"], { type: "audio/ogg" }));
  expect(fields).toEqual({ name: "bell", emoji: "\u{1F514}", file: true });
  expect(s.id).toBe("5");
});

it("uploads an avatar and applies the USER_UPDATE", async () => {
  let hasFile = false;
  server.use(http.put(`${BASE}/api/users/@me/avatar`, async ({ request }) => {
    hasFile = (await request.formData()).get("file") instanceof File;
    return HttpResponse.json({ ...ready.user, avatar_url: "/api/avatars/1?v=0123456789ab" });
  }));
  const client = readyClient();
  const u = await client.uploadAvatar(new Blob(["x"], { type: "image/png" }));
  expect(hasFile).toBe(true);
  expect(u.avatar_url).toBe("/api/avatars/1?v=0123456789ab");
  expect(client.store.getState().me?.avatar_url).toBe("/api/avatars/1?v=0123456789ab");
});

it("removes an avatar", async () => {
  server.use(http.delete(`${BASE}/api/users/@me/avatar`, () => HttpResponse.json({ ...ready.user })));
  const client = readyClient();
  client.apply("USER_UPDATE", { id: "1", username: "alice", display_name: "Alice", custom_status: "", avatar_url: "/a" });
  await client.removeAvatar();
  expect(client.store.getState().me?.avatar_url).toBeUndefined();
});

it("updateMe patches and applies the change", async () => {
  let sent: unknown;
  server.use(http.patch(`${BASE}/api/users/@me`, async ({ request }) => {
    sent = await request.json();
    return HttpResponse.json({ ...ready.user, pronouns: "she/her" });
  }));
  const client = readyClient();
  await client.updateMe({ pronouns: "she/her" });
  expect(sent).toEqual({ pronouns: "she/her" });
  expect(client.store.getState().me?.pronouns).toBe("she/her");
});

it("openDM reuses a 1:1 DM and creates one otherwise", async () => {
  const bob = { id: "2", username: "bob", display_name: "Bob", custom_status: "" };
  const alice = { id: "1", username: "alice", display_name: "Alice", custom_status: "" };
  const client = new DatropeClient({ baseUrl: BASE, wsUrl: "ws://unused" });
  client.store.setState(applyReady(client.store.getState(), {
    ...ready, dms: [{ id: "700", type: "dm", name: "", position: 0, topic: "", overrides: [], participants: [alice, bob] }],
  }), true);
  expect((await client.openDM("2")).id).toBe("700"); // no request: msw fails on unhandled ones

  let body: unknown;
  server.use(http.post(`${BASE}/api/dms`, async ({ request }) => {
    body = await request.json();
    return HttpResponse.json({ id: "701", type: "dm", name: "", position: 0, topic: "", overrides: [], participants: [alice, { ...bob, id: "3" }] });
  }));
  const ch = await client.openDM("3");
  expect(body).toEqual({ recipient_ids: ["3"] });
  expect(client.store.getState().dmIds).toContain(ch.id);
});

it("searches with the local UTC offset", async () => {
  let url: URL | undefined;
  server.use(http.get(`${BASE}/api/search`, ({ request }) => {
    url = new URL(request.url);
    return HttpResponse.json({ results: [], filters: { terms: ["wingspan"] }, total: 0 });
  }));
  const r = await readyClient().search("wingspan from:alice");
  expect(url?.searchParams.get("q")).toBe("wingspan from:alice");
  expect(url?.searchParams.get("utc_offset")).toBe(String(-new Date().getTimezoneOffset()));
  expect(url?.searchParams.has("cursor")).toBe(false);
  expect(r.total).toBe(0);
});

it("loads a window around a message", async () => {
  let around: string | null = null;
  server.use(http.get(`${BASE}/api/channels/:id/messages`, ({ request }) => {
    around = new URL(request.url).searchParams.get("around");
    return HttpResponse.json([message({ content: "old", nonce: "" })]);
  }));
  const client = readyClient();
  await client.loadAround("300", "77");
  expect(around).toBe("77");
  expect(client.store.getState().messages["300"].items.map((m) => m.content)).toEqual(["old"]);
});

it("drops a window response that was overtaken by a newer one", async () => {
  const gates: Record<string, () => void> = {};
  server.use(http.get(`${BASE}/api/channels/:id/messages`, async ({ request }) => {
    const around = new URL(request.url).searchParams.get("around") ?? "";
    await new Promise<void>((r) => { gates[around] = r; });
    return HttpResponse.json([message({ content: `w${around}`, nonce: "" })]);
  }));
  const client = readyClient();
  const a = client.loadAround("300", "A");
  const b = client.loadAround("300", "B");
  await vi.waitFor(() => expect(Object.keys(gates)).toHaveLength(2));
  gates.B();
  await b;
  gates.A();
  await a;
  expect(client.store.getState().messages["300"].items.map((m) => m.content)).toEqual(["wB"]);
});
