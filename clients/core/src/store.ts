import { createStore } from "zustand/vanilla";
import type { ConnectionStatus } from "./gateway";
import { Perm, WEBHOOK_MASKED, basePerms, channelPerms, hasPerm } from "./perms";
import type {
  Activity, Attachment, Category, MusicPlaylist, MusicState, Channel, ChannelRef, Emoji, Member, MentionItem, MentionsPage, Message, Poll, PollUpdate, ReadState, PresenceStatus, PublicUser, ReactionEvent, Ready, ReplyRef, Role, Server, Sound, User,
  PostDeleted, PostUpdate, ThreadListItem, ThreadUpdate, VoiceState, Welcome,
} from "./types";

export type ClientMessage = Message & { pending?: boolean; failed?: boolean };

export interface ChannelMessages {
  items: ClientMessage[]; // oldest first; pending messages last
  hasMore: boolean;
  gen?: number; // bumped when a load replaces the window, so in-flight loads for the old one can be dropped
  hasNewer?: boolean; // a detached window: newer messages exist that are not loaded, so new ones are not inserted
}

export interface MentionsState {
  items: MentionItem[]; // newest first
  unread: number;
  hasMore: boolean;
  loaded: boolean;
}

export interface ServerState {
  server: Server;
  roles: Record<string, Role>;
  members: Record<string, Member>; // by user ID
  channelIds: string[]; // visible channels, unordered (channelGroups gives sidebar order); never threads
  categories: Record<string, Category>;
}

export interface State {
  me: User | null;
  connection: ConnectionStatus;
  server: ServerState | null; // null until READY, or when I am not a member
  welcome: Welcome | null;
  channels: Record<string, Channel>;
  dmIds: string[];
  messages: Record<string, ChannelMessages>; // only channels whose history was loaded
  posts: Record<string, ThreadListItem[] | undefined>; // forum ID → its posts, once loaded
  presences: Record<string, "online" | "idle" | "offline">;
  readStates: Record<string, { lastReadId?: string; lastMessageId?: string }>;
  typing: Record<string, Record<string, number>>; // channel → user → expiry (ms)
  presence: PresenceStatus; // my chosen status
  voice: Record<string, VoiceState>; // by user ID: who is in voice, in channels I can see
  emoji: Record<string, Emoji>; // custom emoji, by ID
  sounds: Record<string, Sound>; // soundboard sounds, by ID
  mentions: MentionsState; // the mentions inbox
  activities: Record<string, Activity>; // by user ID: live on Twitch, listening on Spotify
  music: Record<string, MusicState>; // by voice channel ID, once loaded or announced
  playlists: Record<string, MusicPlaylist> | null; // the server's saved playlists, by ID; null until loaded
}

export const initialState: State = {
  me: null,
  connection: "closed",
  server: null,
  welcome: null,
  channels: {},
  dmIds: [],
  messages: {},
  posts: {},
  presences: {},
  readStates: {},
  typing: {},
  presence: "online",
  voice: {},
  emoji: {},
  sounds: {},
  mentions: { items: [], unread: 0, hasMore: false, loaded: false },
  activities: {},
  music: {},
  playlists: null,
};

export const createAppStore = () => createStore<State>(() => initialState);

/** Orders Snowflake IDs (decimal strings) numerically. */
export function compareIds(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

const byKey = <T>(xs: T[], key: (x: T) => string) => Object.fromEntries(xs.map((x) => [key(x), x]));

export function applyReady(s: State, r: Ready): State {
  const channels: Record<string, Channel> = {};
  let server: ServerState | null = null;
  // Go serializes nil slices as null, so generated array types are nullable.
  if (r.server) {
    const { roles, members, channels: chs, ...sv } = r.server;
    server = {
      server: sv,
      roles: byKey(roles ?? [], (x) => x.id),
      members: byKey(members ?? [], (m) => m.user.id),
      channelIds: (chs ?? []).filter((c) => c.type !== "thread").map((c) => c.id),
      categories: byKey(r.server.categories ?? [], (c) => c.id),
    };
    for (const c of chs ?? []) channels[c.id] = c;
  }
  const dms = r.dms ?? [];
  for (const dm of dms) channels[dm.id] = dm;
  return {
    ...s,
    me: r.user,
    server,
    welcome: null,
    channels,
    dmIds: dms.map((d) => d.id),
    messages: {},
    posts: {},
    typing: {},
    voice: byKey(r.voice_states ?? [], (v) => v.user_id),
    emoji: byKey(r.emoji ?? [], (e) => e.id),
    sounds: byKey(r.sounds ?? [], (x) => x.id),
    mentions: initialState.mentions,
    presences: Object.fromEntries((r.presences ?? []).map((p) => [p.user_id, p.status])),
    activities: byKey(r.activities ?? [], (a) => a.user_id),
    readStates: Object.fromEntries(
      (r.read_states ?? []).map((x) => [x.channel_id, { lastReadId: x.last_read_id, lastMessageId: x.last_message_id }]),
    ),
  };
}

function insertSorted(items: ClientMessage[], m: ClientMessage): ClientMessage[] {
  const confirmed = items.filter((x) => !x.pending);
  const pending = items.filter((x) => x.pending);
  confirmed.push(m);
  confirmed.sort((a, b) => compareIds(a.id, b.id));
  return [...confirmed, ...pending];
}

function updateMessages(s: State, channelId: string, fn: (items: ClientMessage[]) => ClientMessage[]): State {
  const list = s.messages[channelId];
  if (!list) return s;
  return { ...s, messages: { ...s.messages, [channelId]: { ...list, items: fn(list.items) } } };
}

const REPLY_PREVIEW_LEN = 200; // characters of the original a reply quotes, as the server sends them

/** Updates the quoted original in replies to messageId. */
function updateReplies(items: ClientMessage[], messageId: string, change: Partial<ReplyRef>): ClientMessage[] {
  return items.map((x) => (x.reply_to?.id === messageId ? { ...x, reply_to: { ...x.reply_to, ...change } } : x));
}

function updateServer(s: State, fn: (c: ServerState) => ServerState): State {
  return s.server ? { ...s, server: fn(s.server) } : s;
}

function withoutTyping(typing: State["typing"], channelId: string, userId: string): State["typing"] {
  const t = typing[channelId];
  if (!t?.[userId]) return typing;
  const rest = { ...t };
  delete rest[userId];
  return { ...typing, [channelId]: rest };
}

function sortChannelIds(s: State, ids: string[]): string[] {
  return [...ids].sort((a, b) => (s.channels[a]?.position ?? 0) - (s.channels[b]?.position ?? 0) || compareIds(a, b));
}

/** Changes the thread summary on a thread channel's parent message, if loaded. */
function patchThreadSummary(s: State, thread: Channel, fn: (m: ClientMessage) => ClientMessage): State {
  if (!thread.parent_channel_id || !thread.parent_message_id) return s;
  const parentId = thread.parent_message_id;
  return updateMessages(s, thread.parent_channel_id, (items) => items.map((m) => (m.id === parentId ? fn(m) : m)));
}

function upsertChannel(s: State, c: Channel): State {
  const next = { ...s, channels: { ...s.channels, [c.id]: c } };
  if (c.type === "thread") {
    return patchThreadSummary(next, c, (m) => (m.thread?.id === c.id ? { ...m, thread: { ...m.thread, name: c.name } } : m));
  }
  if (c.type !== "dm") {
    return updateServer(next, (cs) => ({
      ...cs,
      channelIds: sortChannelIds(next, cs.channelIds.includes(c.id) ? cs.channelIds : [...cs.channelIds, c.id]),
    }));
  }
  return next.dmIds.includes(c.id) ? next : { ...next, dmIds: [c.id, ...next.dmIds] };
}

function removeChannel(s: State, id: string): State {
  // Drop the summary of a deleted thread from its parent message, even if the thread itself was never loaded.
  for (const [cid, list] of Object.entries(s.messages)) {
    if (list.items.some((m) => m.thread?.id === id)) {
      s = updateMessages(s, cid, (items) => items.map(({ thread, ...m }) => (thread && thread.id !== id ? { ...m, thread } : m)));
    }
  }
  const channels = { ...s.channels };
  delete channels[id];
  const messages = { ...s.messages };
  delete messages[id];
  const posts = { ...s.posts };
  delete posts[id];
  const inChannel = Object.values(s.voice).some((v) => v.channel_id === id);
  const voice = inChannel ? Object.fromEntries(Object.entries(s.voice).filter(([, v]) => v.channel_id !== id)) : s.voice;
  let next: State = { ...s, channels, messages, posts, voice, dmIds: s.dmIds.filter((x) => x !== id) };
  next = updateServer(next, (cs) => (cs.channelIds.includes(id) ? { ...cs, channelIds: cs.channelIds.filter((x) => x !== id) } : cs));
  // A channel's threads go with it.
  for (const c of Object.values(s.channels)) if (c.type === "thread" && c.parent_channel_id === id) next = removeChannel(next, c.id);
  return next;
}

function leaveServer(s: State): State {
  if (!s.server) return s;
  let next = s;
  for (const ch of s.server.channelIds) next = removeChannel(next, ch);
  return { ...next, server: null, welcome: null };
}

export function publicUser(u: User): PublicUser {
  return { id: u.id, username: u.username, display_name: u.display_name, custom_status: u.custom_status,
    pronouns: u.pronouns, about_me: u.about_me, avatar_url: u.avatar_url, links: u.links, banner_url: u.banner_url,
    guest_expires_at: u.guest_expires_at };
}

/** A person's public profile from wherever the state has it: the server, a DM, or me. */
export function findUser(s: State, userId: string): PublicUser | undefined {
  const m = s.server?.members[userId];
  if (m) return m.user;
  for (const id of s.dmIds) {
    const p = s.channels[id]?.participants?.find((x) => x.id === userId);
    if (p) return p;
  }
  return s.me?.id === userId ? publicUser(s.me) : undefined;
}

/** My 1:1 DM with a user, if there is one. */
export function findDM(s: State, userId: string): string | undefined {
  return s.dmIds.find((id) => {
    const c = s.channels[id];
    const ps = c?.participants ?? [];
    return !c?.group && ps.length === 2 && ps.some((p) => p.id === userId) && ps.some((p) => p.id === s.me?.id);
  });
}

function renameUser(s: State, u: PublicUser): State {
  const server = updateServer(s, (cs) => {
    const m = cs.members[u.id];
    return m ? { ...cs, members: { ...cs.members, [u.id]: { ...m, user: u } } } : cs;
  }).server;
  const channels = { ...s.channels };
  for (const id of s.dmIds) {
    const c = channels[id];
    if (c?.participants?.some((p) => p.id === u.id)) {
      channels[id] = { ...c, participants: c.participants.map((p) => (p.id === u.id ? u : p)) };
    }
  }
  const profile = { display_name: u.display_name, custom_status: u.custom_status, pronouns: u.pronouns, about_me: u.about_me, avatar_url: u.avatar_url, links: u.links, banner_url: u.banner_url };
  const me = s.me?.id === u.id ? { ...s.me, ...profile } : s.me;
  return { ...s, server, channels, me };
}

/** Where a channel sits, for the inbox and search results. Every non-thread channel I can see is in the store. */
export function channelRef(s: State, channelId: string): ChannelRef {
  const c = s.channels[channelId];
  if (!c) return { id: channelId, type: "thread", name: "" };
  if (c.type === "dm") return { id: c.id, type: "dm", name: "" };
  if (c.type === "thread") {
    const parent = c.parent_channel_id;
    return { id: c.id, type: "thread", name: c.name, parent_id: parent, parent_name: (parent && s.channels[parent]?.name) || "" };
  }
  return { id: c.id, type: c.type, name: c.name };
}

function mapMentions(s: State, fn: (i: MentionItem) => MentionItem): State {
  if (!s.mentions.items.length) return s;
  return { ...s, mentions: { ...s.mentions, items: s.mentions.items.map(fn) } };
}

function addMention(s: State, m: Message): State {
  if (!s.mentions.loaded || !s.me || m.author?.id === s.me.id || !(m.mentions?.includes(s.me.id) || m.mention_everyone)) return s;
  if (s.mentions.items.some((i) => i.message.id === m.id)) return s;
  const item: MentionItem = { message: m, channel: channelRef(s, m.channel_id), unread: true };
  return { ...s, mentions: { ...s.mentions, items: [item, ...s.mentions.items], unread: s.mentions.unread + 1 } };
}

function dropMention(s: State, messageId: string): State {
  const item = s.mentions.items.find((i) => i.message.id === messageId);
  if (!item) return s;
  const unread = item.unread ? Math.max(0, s.mentions.unread - 1) : s.mentions.unread;
  return { ...s, mentions: { ...s.mentions, items: s.mentions.items.filter((i) => i !== item), unread } };
}

/** A forum's newest message is the newest across its posts; my own messages count as read, as in MESSAGE_CREATE
 *  (which comes first and has already marked the post read up to my message, loaded or not). */
function bumpForumRead(s: State, d: PostUpdate): State {
  const last = d.post.summary.last_message_id;
  const prev = s.readStates[d.channel_id] ?? {};
  if (!last || (prev.lastMessageId && compareIds(prev.lastMessageId, last) >= 0)) return s;
  const myId = s.me?.id;
  const mine = s.readStates[d.post.channel.id]?.lastReadId === last || (!!myId && last === d.post.first_message_id && d.post.author?.id === myId);
  return { ...s, readStates: { ...s.readStates, [d.channel_id]: { ...prev, lastMessageId: last, ...(mine ? { lastReadId: last } : {}) } } };
}

/** Applies a gateway DISPATCH. Unknown types leave the state unchanged. */
export function applyEvent(s: State, type: string, data: unknown, now = Date.now()): State {
  switch (type) {
    case "MESSAGE_CREATE": {
      const m = data as Message;
      const prev = s.readStates[m.channel_id] ?? {};
      const mine = !!m.author && m.author.id === s.me?.id; // a webhook message has no author
      const next: State = {
        ...s,
        typing: m.author ? withoutTyping(s.typing, m.channel_id, m.author.id) : s.typing,
        readStates: {
          ...s.readStates,
          [m.channel_id]: {
            lastMessageId: prev.lastMessageId && compareIds(prev.lastMessageId, m.id) > 0 ? prev.lastMessageId : m.id,
            lastReadId: mine ? m.id : prev.lastReadId,
          },
        },
      };
      const withMention = addMention(next, m);
      if (withMention.messages[m.channel_id]?.hasNewer) {
        // A detached window waits for the present, but my own pending send is still resolved.
        const mine = m.nonce && withMention.messages[m.channel_id].items.some((x) => x.pending && x.nonce === m.nonce);
        if (!mine) return withMention;
      }
      return updateMessages(withMention, m.channel_id, (items) => {
        const rest = items.filter((x) => !(m.nonce && x.pending && x.nonce === m.nonce));
        // A copy I already have may be newer (the POST response can trail the gateway's events).
        return rest.some((x) => x.id === m.id) ? rest : insertSorted(rest, { ...m });
      });
    }
    case "MESSAGE_UPDATE": {
      const m = data as Message;
      // Reactions, polls (with my_votes, which events never carry) and thread summaries are kept up to
      // date by their own events and responses, so the existing copy wins.
      const inbox = mapMentions(s, (i) => {
        if (i.message.id !== m.id) return i;
        // The inbox gets no POLL_UPDATE, so take the event's counts but keep my votes.
        const poll = m.poll && i.message.poll ? { ...m.poll, my_votes: i.message.poll.my_votes } : m.poll;
        return { ...i, message: { ...m, reactions: i.message.reactions, ...(poll ? { poll } : {}) } };
      });
      return updateMessages(inbox, m.channel_id, (items) => updateReplies(
        items.map((x) => (x.id === m.id ? { ...m, reactions: x.reactions, thread: m.thread ?? x.thread, ...(x.poll ? { poll: x.poll } : {}) } : x)),
        m.id, { content: Array.from(m.content).slice(0, REPLY_PREVIEW_LEN).join("") },
      ));
    }
    case "MESSAGE_DELETE": {
      const d = data as { id: string; channel_id: string };
      return updateMessages(dropMention(s, d.id), d.channel_id, (items) => updateReplies(
        items.map((x) => {
          if (x.id !== d.id) return x;
          const { pinned_at: _pinnedAt, ...rest } = x;
          return { ...rest, deleted: true, content: "", pinned: false };
        }),
        d.id, { deleted: true, content: "" },
      ));
    }
    case "TYPING_START": {
      const d = data as { channel_id: string; user_id: string };
      if (d.user_id === s.me?.id) return s;
      return { ...s, typing: { ...s.typing, [d.channel_id]: { ...s.typing[d.channel_id], [d.user_id]: now + 10_000 } } };
    }
    case "MUSIC_UPDATE": {
      const m = data as MusicState;
      return { ...s, music: { ...s.music, [m.channel_id]: m } };
    }
    case "MUSIC_PLAYLIST_UPDATE": {
      const p = data as MusicPlaylist;
      return s.playlists ? { ...s, playlists: { ...s.playlists, [p.id]: p } } : s;
    }
    case "MUSIC_PLAYLIST_DELETE": {
      if (!s.playlists) return s;
      const { [(data as { id: string }).id]: _gone, ...rest } = s.playlists;
      return { ...s, playlists: rest };
    }
    case "ACTIVITY_UPDATE": {
      const d = data as { user_id: string; activity?: Activity | null };
      const { [d.user_id]: _old, ...rest } = s.activities;
      return { ...s, activities: d.activity ? { ...rest, [d.user_id]: d.activity } : rest };
    }
    case "CHANNEL_CREATE":
      return upsertChannel(s, data as Channel);
    case "CHANNEL_UPDATE": {
      const c = data as Channel;
      const list = s.posts[c.id];
      if (c.type !== "forum" || !list) return upsertChannel(s, c);
      // Posts keep only the tags the forum still offers, in its spelling (as the server does).
      const offered = new Map((c.tags ?? []).map((t) => [t.toLowerCase(), t]));
      const posts = list.map((p) => ({
        ...p,
        channel: { ...p.channel, tags: (p.channel.tags ?? []).flatMap((t) => offered.get(t.toLowerCase()) ?? []) },
      }));
      return upsertChannel({ ...s, posts: { ...s.posts, [c.id]: posts } }, c);
    }
    case "CHANNEL_DELETE":
      return removeChannel(s, (data as { id: string }).id);
    case "CATEGORY_CREATE":
    case "CATEGORY_UPDATE": {
      const c = data as Category;
      return updateServer(s, (cs) => ({ ...cs, categories: { ...cs.categories, [c.id]: c } }));
    }
    case "CATEGORY_DELETE": {
      const { id } = data as { id: string };
      const channels = Object.fromEntries(Object.entries(s.channels).map(([k, c]) => {
        if (c.category_id !== id) return [k, c];
        const { category_id: _category, ...rest } = c;
        return [k, rest];
      }));
      return updateServer({ ...s, channels }, (cs) => {
        const categories = { ...cs.categories };
        delete categories[id];
        return { ...cs, categories };
      });
    }
    case "THREAD_UPDATE": {
      const d = data as ThreadUpdate;
      return updateMessages(s, d.channel_id, (items) => items.map((m) => (m.id === d.message_id ? { ...m, thread: d.thread } : m)));
    }
    case "POST_UPDATE": {
      const d = data as PostUpdate;
      const read = bumpForumRead(s, d);
      const list = read.posts[d.channel_id];
      if (!list) return read; // not loaded: the forum view loads the whole list
      const at = list.findIndex((p) => p.channel.id === d.post.channel.id);
      const next = at < 0 ? [...list, d.post] : list.map((p, i) => (i === at ? d.post : p));
      return { ...read, posts: { ...read.posts, [d.channel_id]: next } };
    }
    case "POST_DELETE": {
      const d = data as PostDeleted;
      const list = s.posts[d.channel_id];
      const next = list ? { ...s, posts: { ...s.posts, [d.channel_id]: list.filter((p) => p.channel.id !== d.id) } } : s;
      return removeChannel(next, d.id);
    }
    case "SERVER_UPDATE":
      return updateServer(s, (cs) => ({ ...cs, server: data as Server }));
    case "WELCOME_UPDATE":
      return { ...s, welcome: data as Welcome };
    case "MEMBER_ADD":
    case "MEMBER_UPDATE": {
      const m = data as Member;
      return updateServer(s, (cs) => ({ ...cs, members: { ...cs.members, [m.user.id]: m } }));
    }
    case "MEMBER_REMOVE": {
      const d = data as { user_id: string };
      if (d.user_id === s.me?.id) return leaveServer(s);
      return updateServer(s, (cs) => {
        const members = { ...cs.members };
        delete members[d.user_id];
        return { ...cs, members };
      });
    }
    case "ROLE_CREATE":
    case "ROLE_UPDATE": {
      const r = data as Role;
      return updateServer(s, (cs) => ({ ...cs, roles: { ...cs.roles, [r.id]: r } }));
    }
    case "ROLE_DELETE": {
      const d = data as { id: string };
      return updateServer(s, (cs) => {
        const roles = { ...cs.roles };
        delete roles[d.id];
        const members = Object.fromEntries(Object.entries(cs.members).map(([k, m]) =>
          [k, { ...m, role_ids: (m.role_ids ?? []).filter((r) => r !== d.id) }]));
        return { ...cs, roles, members };
      });
    }
    case "PRESENCE_UPDATE": {
      const d = data as { user_id: string; status: "online" | "idle" | "offline" };
      return { ...s, presences: { ...s.presences, [d.user_id]: d.status } };
    }
    case "USER_UPDATE":
      return renameUser(s, data as PublicUser);
    case "VOICE_STATE_UPDATE": {
      const v = data as VoiceState;
      const voice = { ...s.voice };
      if (v.channel_id) voice[v.user_id] = v;
      else if (v.user_id in voice) delete voice[v.user_id]; // left voice
      else return s;
      return { ...s, voice };
    }
    case "EMOJI_UPDATE":
      return { ...s, emoji: byKey((data as { emoji: Emoji[] | null }).emoji ?? [], (e) => e.id) };
    case "SOUND_UPDATE":
      return { ...s, sounds: byKey((data as { sounds: Sound[] | null }).sounds ?? [], (x) => x.id) };
    case "MESSAGE_REACTION_ADD":
    case "MESSAGE_REACTION_REMOVE": {
      const d = data as ReactionEvent;
      const add = type === "MESSAGE_REACTION_ADD";
      return updateMessages(s, d.channel_id, (items) => items.map((m) => {
        if (m.id !== d.message_id) return m;
        const reactions = [...(m.reactions ?? [])];
        const i = reactions.findIndex((r) => r.emoji === d.emoji);
        const users = i >= 0 ? reactions[i].user_ids ?? [] : [];
        if (add === users.includes(d.user_id)) return m; // nothing changes
        const next = add ? [...users, d.user_id] : users.filter((u) => u !== d.user_id);
        if (next.length === 0) reactions.splice(i, 1);
        else if (i >= 0) reactions[i] = { emoji: d.emoji, count: next.length, user_ids: next };
        else reactions.push({ emoji: d.emoji, count: 1, user_ids: next });
        return { ...m, reactions };
      }));
    }
    case "POLL_UPDATE": {
      const d = data as PollUpdate;
      const counts = d.options ?? [];
      return updateMessages(s, d.channel_id, (items) => items.map((m) => {
        if (m.id !== d.message_id || !m.poll) return m;
        const options = (m.poll.options ?? []).map((o, i) => ({ ...o, count: counts[i]?.count ?? o.count }));
        return { ...m, poll: { ...m.poll, options, total_voters: d.total_voters, ended: d.ended } };
      }));
    }
    default:
      return s;
  }
}

export function addPending(
  s: State, channelId: string, nonce: string, content: string, attachments: Attachment[] = [], replyTo?: ReplyRef,
): State {
  if (!s.me) return s;
  const pending: ClientMessage = {
    id: `pending:${nonce}`, channel_id: channelId, nonce, content, attachments, pending: true, deleted: false, pinned: false,
    reply_to: replyTo, mentions: [], reactions: [],
    author: { id: s.me.id, username: s.me.username, display_name: s.me.display_name, custom_status: s.me.custom_status },
    created_at: new Date().toISOString(),
  };
  const list = s.messages[channelId] ?? { items: [], hasMore: true };
  return { ...s, messages: { ...s.messages, [channelId]: { ...list, items: [...list.items, pending] } } };
}

export function markFailed(s: State, channelId: string, nonce: string): State {
  return updateMessages(s, channelId, (items) => items.map((x) => (x.pending && x.nonce === nonce ? { ...x, failed: true } : x)));
}

/**
 * Merges only my_votes from a vote's response into the stored poll. Counts, total_voters and ended
 * come from POLL_UPDATE; the response may be older than one that already arrived.
 */
export function setPoll(s: State, channelId: string, messageId: string, poll: Poll): State {
  return updateMessages(s, channelId, (items) =>
    items.map((m) => (m.id === messageId && m.poll ? { ...m, poll: { ...m.poll, my_votes: poll.my_votes } } : m)));
}

/** Adds an older page (as the API returns it: newest first). */
export function prependHistory(s: State, channelId: string, page: Message[], limit: number): State {
  const list = s.messages[channelId] ?? { items: [], hasMore: true };
  let items = list.items;
  for (const m of page) if (!items.some((x) => x.id === m.id)) items = insertSorted(items, m);
  return { ...s, messages: { ...s.messages, [channelId]: { ...list, items, hasMore: page.length === limit } } };
}

/** True when the channel has messages newer than the newest confirmed one in items. */
function newerExists(s: State, channelId: string, items: ClientMessage[]): boolean {
  const last = s.readStates[channelId]?.lastMessageId;
  const newest = items.filter((x) => !x.pending).at(-1)?.id;
  return !!last && (!newest || compareIds(last, newest) > 0);
}

const sortedPage = (page: Message[]): ClientMessage[] => [...page].sort((a, b) => compareIds(a.id, b.id));

/** Replaces the loaded messages with a window (as the API returns it: newest first), e.g. around a message. */
export function replaceWindow(s: State, channelId: string, page: Message[]): State {
  const items = sortedPage(page);
  const gen = (s.messages[channelId]?.gen ?? 0) + 1;
  return { ...s, messages: { ...s.messages, [channelId]: { items, hasMore: true, hasNewer: newerExists(s, channelId, items), gen } } };
}

/** Adds a page of newer messages after a detached window. */
export function appendNewer(s: State, channelId: string, page: Message[]): State {
  const list = s.messages[channelId] ?? { items: [], hasMore: true };
  let items = list.items;
  for (const m of page) if (!items.some((x) => x.id === m.id)) items = insertSorted(items, m);
  return { ...s, messages: { ...s.messages, [channelId]: { ...list, items, hasNewer: newerExists(s, channelId, items) } } };
}

/** Replaces the loaded messages with the latest page, keeping pending sends. */
export function latestWindow(s: State, channelId: string, page: Message[], limit: number): State {
  const pending = (s.messages[channelId]?.items ?? []).filter((x) => x.pending);
  const gen = (s.messages[channelId]?.gen ?? 0) + 1;
  return { ...s, messages: { ...s.messages, [channelId]: { items: [...sortedPage(page), ...pending], hasMore: page.length === limit, hasNewer: false, gen } } };
}

export function setChannels(s: State, chs: Channel[]): State {
  let next = s;
  for (const id of s.server?.channelIds ?? []) if (!chs.some((c) => c.id === id)) next = removeChannel(next, id);
  for (const c of chs) next = upsertChannel(next, c);
  return next;
}

export function setMembers(s: State, members: Member[]): State {
  return updateServer(s, (cs) => ({ ...cs, members: byKey(members, (m) => m.user.id) }));
}

export function ackLocal(s: State, channelId: string, messageId: string): State {
  const prev = s.readStates[channelId] ?? {};
  let next = s;
  if (!(prev.lastReadId && compareIds(prev.lastReadId, messageId) >= 0)) {
    next = { ...next, readStates: { ...next.readStates, [channelId]: { ...prev, lastReadId: messageId } } };
  }
  const flip = (i: MentionItem) => i.unread && i.channel.id === channelId && compareIds(i.message.id, messageId) <= 0;
  const flipped = next.mentions.items.filter(flip).length;
  if (flipped) {
    const m = next.mentions;
    next = { ...next, mentions: { ...m, items: m.items.map((i) => (flip(i) ? { ...i, unread: false } : i)), unread: Math.max(0, m.unread - flipped) } };
  }
  return next;
}

/** Marks every inbox mention read, with the read positions the server moved (idempotent; never moves one back). */
export function markMentionsRead(s: State, states: ReadState[]): State {
  let next = s;
  for (const r of states) if (r.last_read_id) next = ackLocal(next, r.channel_id, r.last_read_id);
  const m = next.mentions;
  return { ...next, mentions: { ...m, items: m.items.map((i) => (i.unread ? { ...i, unread: false } : i)), unread: 0 } };
}

export function setMentions(s: State, page: MentionsPage, older: boolean): State {
  const incoming = page.items ?? [];
  const items = older
    ? [...s.mentions.items, ...incoming.filter((i) => !s.mentions.items.some((x) => x.message.id === i.message.id))]
    : incoming;
  return { ...s, mentions: { items, hasMore: !!page.next_cursor, unread: page.unread_count ?? s.mentions.unread, loaded: true } };
}

export function expireTyping(s: State, now = Date.now()): State {
  let changed = false;
  const typing: State["typing"] = {};
  for (const [ch, users] of Object.entries(s.typing)) {
    typing[ch] = Object.fromEntries(Object.entries(users).filter(([, until]) => {
      const keep = until > now;
      if (!keep) changed = true;
      return keep;
    }));
  }
  return changed ? { ...s, typing } : s;
}

/** Who is in a channel's voice, in a stable order. Returns a new array: select it with useShallow. */
export function voiceMembers(s: State, channelId: string): VoiceState[] {
  return Object.values(s.voice).filter((v) => v.channel_id === channelId).sort((a, b) => compareIds(a.user_id, b.user_id));
}

export function myRoleIds(s: State): string[] {
  return (s.me && s.server?.members[s.me.id]?.role_ids) ?? [];
}

/** True while the rules gate hides everything but the welcome page from me. */
export function isGated(s: State): boolean {
  const sv = s.server;
  if (!sv || !s.me || !sv.server.rules_gate || sv.server.owner_id === s.me.id) return false;
  return !sv.members[s.me.id]?.accepted_rules_at;
}

export function myBasePerms(s: State): number {
  if (!s.server || !s.me || isGated(s)) return 0;
  return basePerms(s.server.server, Object.values(s.server.roles), s.me.id, myRoleIds(s));
}

/** Whether I may create invites: guests never may, whatever their roles allow. */
export function canCreateInvites(s: State): boolean {
  return !s.me?.guest_expires_at && hasPerm(myBasePerms(s), Perm.CreateInvite);
}

/** My permissions in a channel as its roles and overrides give them, before a webhook channel's mask. */
function rawChannelPerms(s: State, ch: Channel): number {
  if (!s.me) return 0;
  if (ch.type === "dm") return channelPerms({ id: "", owner_id: "" }, [], s.me.id, [], ch);
  if (!s.server) return 0;
  return channelPerms(s.server.server, Object.values(s.server.roles), s.me.id, myRoleIds(s), ch, isGated(s));
}

/** My permissions in a channel or DM. Nobody sends or attaches in a webhook channel (the server's channels.Perms). */
export function myChannelPerms(s: State, channelId: string): number {
  const ch = s.channels[channelId];
  if (!ch) return 0;
  const p = rawChannelPerms(s, ch);
  return ch.type === "webhook" ? p & ~WEBHOOK_MASKED : p;
}

/** My permissions in the threads of a channel: the channel's own, without a webhook channel's mask. */
export function myThreadPerms(s: State, parentChannelId: string): number {
  const ch = s.channels[parentChannelId];
  return ch ? rawChannelPerms(s, ch) : 0;
}

/** Roles from highest to lowest; @everyone last. Returns a new array: select it with useShallow. */
export function rolesByRank(s: State): Role[] {
  return Object.values(s.server?.roles ?? {}).sort((a, b) => b.position - a.position);
}

/** Custom emoji by name order. Returns a new array: select it with useShallow. */
export function emojiList(s: State): Emoji[] {
  return Object.values(s.emoji).sort((a, b) => a.name.localeCompare(b.name));
}

/** The custom emoji ID in a reaction's "custom:<id>", or null for a Unicode emoji. */
export function customEmojiId(emoji: string): string | null {
  return emoji.startsWith("custom:") ? emoji.slice(7) : null;
}

/** Visible channels grouped for the sidebar. Returns new objects: select it with useShallow or useMemo over its inputs. */
export function channelGroups(s: State): { uncategorised: string[]; categories: { category: Category; channelIds: string[] }[] } {
  const sv = s.server;
  if (!sv) return { uncategorised: [], categories: [] };
  const byPos = (a: string, b: string) => {
    const x = s.channels[a], y = s.channels[b];
    return Number(y?.type === "welcome") - Number(x?.type === "welcome") || (x?.position ?? 0) - (y?.position ?? 0) || compareIds(a, b);
  };
  const groups = new Map<string, string[]>();
  const uncategorised: string[] = [];
  for (const id of sv.channelIds) {
    const cat = s.channels[id]?.category_id;
    if (cat && sv.categories[cat]) (groups.get(cat) ?? groups.set(cat, []).get(cat)!).push(id);
    else uncategorised.push(id);
  }
  const categories = Object.values(sv.categories)
    .sort((a, b) => a.position - b.position || compareIds(a.id, b.id))
    .map((category) => ({ category, channelIds: (groups.get(category.id) ?? []).sort(byPos) }));
  return { uncategorised: uncategorised.sort(byPos), categories };
}

/** Visible channel IDs in sidebar order: uncategorised first, then each category in order. */
export function sidebarChannelIds(s: State): string[] {
  const g = channelGroups(s);
  return [...g.uncategorised, ...g.categories.flatMap((c) => c.channelIds)];
}

/** Soundboard sounds by name order. Returns a new array: select it with useShallow. */
export function soundList(s: State): Sound[] {
  return Object.values(s.sounds).sort((a, b) => a.name.localeCompare(b.name));
}
