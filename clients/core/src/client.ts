import { ApiError, createApi, unwrap, type Api } from "./api";
import { Gateway } from "./gateway";
import {
  ackLocal, addPending, applyEvent, applyReady, createAppStore, initialState, markFailed, prependHistory,
  appendNewer, findDM, isGated, latestWindow, markMentionsRead, publicUser, replaceWindow, setChannels, setMembers, setMentions, setPoll, type State,
} from "./store";
import type {
  Album, AlbumVisibility, Attachment, Category, Channel, Emoji, FileKind, FilesPage, JoinVoiceResponse, LibraryTrack, Member, MusicPlaylist, MusicState, PlaylistAdd, PlaylistAddResult, PlaylistDetail, QueueRequest, QueueResult, RepeatMode, Message, Poll, PollRequest, PresenceStatus, PublicUser, Role, SearchResponse, ReplyRef, SevenTVPage, SevenTVSet, Sound,
  ThreadListItem, User, Webhook, WebhookWithURL, WatchUpdate,
} from "./types";

export interface ClientOptions {
  baseUrl: string; // "" for the web app
  wsUrl: string; // e.g. "wss://chat.example.com/ws"
  token?: () => string | undefined;
  WebSocket?: typeof WebSocket;
  onSignedOut?: () => void;
}

/** API + gateway + store: everything a Datrope UI needs. */
/** A crop in source pixels, sent with an uncropped GIF avatar or banner. */
export type ImageCrop = { x: number; y: number; w: number; h: number };

export type FilesParams = { gallery?: string; kinds?: FileKind[]; channels?: string[]; uploader?: string; q?: string; before?: string; limit?: number };

function imageForm(image: Blob, name: string, crop?: ImageCrop): FormData {
  const form = new FormData();
  form.append("file", image, `${name}.${image.type === "image/gif" ? "gif" : "png"}`);
  if (crop) {
    form.append("crop_x", String(crop.x));
    form.append("crop_y", String(crop.y));
    form.append("crop_w", String(crop.w));
    form.append("crop_h", String(crop.h));
  }
  return form;
}

export class DatropeClient {
  readonly api: Api;
  readonly store = createAppStore();
  private gateway?: Gateway;
  private lastTyping: Record<string, number> = {};
  private listeners = new Set<(type: string, data: unknown) => void>();

  constructor(private readonly o: ClientOptions) {
    this.api = createApi({ baseUrl: o.baseUrl, token: o.token });
  }

  private set(fn: (s: State) => State) {
    this.store.setState(fn(this.store.getState()), true);
  }

  connect(status: PresenceStatus = "online") {
    this.gateway?.close();
    this.set((s) => ({ ...s, presence: status }));
    this.gateway = new Gateway({
      url: this.o.wsUrl,
      token: this.o.token,
      WebSocket: this.o.WebSocket,
      status,
      onReady: (r) => this.set((s) => applyReady(s, r)),
      onDispatch: (type, data) => this.apply(type, data),
      onStatus: (connection) => this.set((s) => ({ ...s, connection })),
      onSessionInvalid: () => {
        this.store.setState(initialState, true);
        this.o.onSignedOut?.();
      },
    });
    this.gateway.connect();
  }

  disconnect() {
    this.gateway?.close();
    this.gateway = undefined;
    this.store.setState(initialState, true);
  }

  setPresence(status: PresenceStatus) {
    this.set((s) => ({ ...s, presence: status }));
    this.gateway?.setPresence(status);
  }

  /**
   * Applies an event. The gateway calls this for every DISPATCH; UIs call it
   * with a REST response (e.g. MESSAGE_CREATE after sending)
   * when they need the state before the event arrives. Applying twice is safe.
   */
  apply(type: string, data: unknown) {
    const wasGated = isGated(this.store.getState());
    this.set((s) => applyEvent(s, type, data));
    if (wasGated && !isGated(this.store.getState())) {
      // The gate lifted (rules accepted in another tab, or the gate switched off): redo READY.
      this.connect(this.store.getState().presence);
    } else {
      this.follow(type, data);
    }
    for (const fn of this.listeners) {
      try {
        fn(type, data);
      } catch (e) {
        console.error("datrope: event listener failed", e);
      }
    }
  }

  /** Calls fn for every event applied (see apply). Returns a function that stops it. */
  onEvent(fn: (type: string, data: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Some events only say "something changed"; fetch what they imply. */
  private follow(type: string, data: unknown) {
    if (type === "MEMBER_UPDATE" && (data as Member).user.id === this.store.getState().me?.id) {
      this.refreshChannels(); // my roles changed what I can see
    } else if (type === "ROLE_UPDATE" || type === "ROLE_DELETE") {
      this.refreshChannels();
    }
  }

  private refreshTimer?: ReturnType<typeof setTimeout>;
  private refreshing = false;
  private refreshAgain = false;

  /** Reloads the channels once for a burst of events: one request in flight, at most one more queued. */
  private refreshChannels() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => void this.runRefresh(), 50);
  }

  private async runRefresh() {
    this.refreshTimer = undefined;
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      await this.loadChannels();
    } catch (e) {
      console.warn("datrope: refreshing channels failed", e);
    } finally {
      this.refreshing = false;
    }
    if (this.refreshAgain) {
      this.refreshAgain = false;
      this.refreshChannels();
    }
  }

  async loadChannels() {
    if (!this.store.getState().server) return;
    const chs = await unwrap(this.api.GET("/api/server/channels"));
    this.set((s) => setChannels(s, chs ?? []));
  }

  async createCategory(name: string): Promise<Category> {
    return unwrap(this.api.POST("/api/server/categories", { body: { name } }));
  }

  async updateCategory(id: string, patch: { name?: string; position?: number }): Promise<Category> {
    return unwrap(this.api.PATCH("/api/server/categories/{categoryID}", { params: { path: { categoryID: id } }, body: patch }));
  }

  async deleteCategory(id: string) {
    await unwrap(this.api.DELETE("/api/server/categories/{categoryID}", { params: { path: { categoryID: id } } }));
  }

  /** Moves a channel into a category (null: out of any) at a position inside that group. */
  async moveChannel(id: string, to: { categoryId: string | null; position: number }): Promise<Channel> {
    return unwrap(this.api.PATCH("/api/channels/{id}", {
      params: { path: { id } },
      body: { ...(to.categoryId === null ? { clear_category: true } : { category_id: to.categoryId }), position: to.position },
    }));
  }

  async setTopic(id: string, topic: string): Promise<Channel> {
    return unwrap(this.api.PATCH("/api/channels/{id}", { params: { path: { id } }, body: { topic } }));
  }

  async pin(channelId: string, messageId: string) {
    await unwrap(this.api.PUT("/api/channels/{id}/pins/{messageID}", { params: { path: { id: channelId, messageID: messageId } } }));
  }

  async unpin(channelId: string, messageId: string) {
    await unwrap(this.api.DELETE("/api/channels/{id}/pins/{messageID}", { params: { path: { id: channelId, messageID: messageId } } }));
  }

  /** Pinned messages, newest pin first. */
  async listPins(channelId: string): Promise<Message[]> {
    return (await unwrap(this.api.GET("/api/channels/{id}/pins", { params: { path: { id: channelId } } }))) ?? [];
  }

  /** Starts a thread on a message (or returns its existing one) and stores the thread channel. */
  async createThread(channelId: string, messageId: string, name?: string): Promise<Channel> {
    const ch = await unwrap(this.api.POST("/api/channels/{id}/messages/{messageID}/thread", {
      params: { path: { id: channelId, messageID: messageId } },
      body: name ? { name } : {},
    }));
    this.apply("CHANNEL_CREATE", ch);
    return ch;
  }

  async listThreads(channelId: string): Promise<ThreadListItem[]> {
    return (await unwrap(this.api.GET("/api/channels/{id}/threads", { params: { path: { id: channelId } } }))) ?? [];
  }

  /** Loads a forum's posts into the store. */
  async loadPosts(forumId: string) {
    const posts = await this.listThreads(forumId);
    this.set((s) => ({ ...s, posts: { ...s.posts, [forumId]: posts } }));
  }

  /** Starts a post in a forum; the POST_UPDATE event (or this response) puts it in the store. */
  async createPost(forumId: string, post: { title: string; content: string; tags?: string[]; attachments?: Attachment[] }): Promise<ThreadListItem> {
    const item = await unwrap(this.api.POST("/api/channels/{id}/posts", {
      params: { path: { id: forumId } },
      body: {
        title: post.title, content: post.content,
        ...(post.tags && post.tags.length > 0 ? { tags: post.tags } : {}),
        ...(post.attachments && post.attachments.length > 0 ? { attachment_ids: post.attachments.map((a) => a.id) } : {}),
      },
    }));
    this.apply("POST_UPDATE", { channel_id: forumId, post: item });
    return item;
  }

  async updatePost(postId: string, patch: { title?: string; tags?: string[] }): Promise<ThreadListItem> {
    const item = await unwrap(this.api.PATCH("/api/channels/{id}/post", { params: { path: { id: postId } }, body: patch }));
    if (item.channel.parent_channel_id) this.apply("POST_UPDATE", { channel_id: item.channel.parent_channel_id, post: item });
    return item;
  }

  /** Deletes a post in the forum forumId (posts are usually not in channels, so the caller names the forum). */
  async deletePost(postId: string, forumId: string) {
    await unwrap(this.api.DELETE("/api/channels/{id}/post", { params: { path: { id: postId } } }));
    this.apply("POST_DELETE", { channel_id: forumId, id: postId });
  }

  /** Fetches one channel (e.g. a thread I have not seen yet) and stores it. */
  async getChannel(id: string): Promise<Channel> {
    const ch = await unwrap(this.api.GET("/api/channels/{id}", { params: { path: { id } } }));
    this.apply("CHANNEL_CREATE", ch);
    return ch;
  }

  async loadMembers() {
    const ms = await unwrap(this.api.GET("/api/server/members"));
    this.set((s) => setMembers(s, ms ?? []));
  }

  async loadWelcome() {
    const w = await unwrap(this.api.GET("/api/server/welcome"));
    this.set((s) => ({ ...s, welcome: w }));
  }

  /** Accepts the rules, then reconnects so READY includes everything the gate hid. */
  async acceptRules() {
    await unwrap(this.api.POST("/api/server/welcome/accept"));
    this.connect(this.store.getState().presence);
  }

  /** Gives me a self-assignable role from the welcome page; MEMBER_UPDATE updates the store. */
  async addMyRole(roleId: string) {
    await unwrap(this.api.PUT("/api/server/me/roles/{roleID}", { params: { path: { roleID: roleId } } }));
  }

  /** Drops a self-assignable role I hold. */
  async removeMyRole(roleId: string) {
    await unwrap(this.api.DELETE("/api/server/me/roles/{roleID}", { params: { path: { roleID: roleId } } }));
  }

  /** Rejoins the server with an invite (after a kick), then reconnects. */
  async joinServer(code: string) {
    await unwrap(this.api.POST("/api/invites/{code}/accept", { params: { path: { code } } }));
    this.connect(this.store.getState().presence);
  }

  /** Joins with a guest link as a new guest account (web: sets the session cookie). */
  async joinAsGuest(code: string, nick: string, deviceName: string): Promise<User> {
    const res = await unwrap(this.api.POST("/api/invites/{code}/guest", {
      params: { path: { code } },
      body: { nick, device_name: deviceName, client: this.o.token ? "native" : "web" },
    }));
    return res.user;
  }

  /** Uploads the server icon or banner (PUT) or a welcome-page image (POST). */
  async uploadServerImage(kind: "icon" | "banner" | "page", file: Blob): Promise<{ url: string; id?: string }> {
    const path = kind === "page" ? "/api/server/images" : `/api/server/${kind}`;
    return (await this.multipart(kind === "page" ? "POST" : "PUT", path, file, "image")) as { url: string; id?: string };
  }

  async deleteServerImage(kind: "icon" | "banner") {
    const res = await fetch(this.url(`/api/server/${kind}`), { method: "DELETE", headers: this.authHeaders(), credentials: "include" });
    if (!res.ok) await this.throwApiError(res);
  }

  /** Updates my profile; omitted fields are unchanged. */
  async updateMe(patch: { display_name?: string; custom_status?: string; pronouns?: string; about_me?: string; links?: string[] }): Promise<User> {
    const u = await unwrap(this.api.PATCH("/api/users/@me", { body: patch }));
    this.apply("USER_UPDATE", publicUser(u));
    return u;
  }

  /** Uploads an avatar; pass crop (source px) with an uncropped GIF and the server crops every frame. */
  async uploadAvatar(image: Blob, crop?: ImageCrop): Promise<User> {
    const u = (await this.multipartForm("PUT", "/api/users/@me/avatar", imageForm(image, "avatar", crop))) as User;
    this.apply("USER_UPDATE", publicUser(u));
    return u;
  }

  async removeAvatar(): Promise<User> {
    const res = await fetch(this.url("/api/users/@me/avatar"), { method: "DELETE", headers: this.authHeaders(), credentials: "include" });
    if (!res.ok) await this.throwApiError(res);
    const u = (await res.json()) as User;
    this.apply("USER_UPDATE", publicUser(u));
    return u;
  }

  /** Uploads a banner; crop works as for uploadAvatar. */
  async uploadBanner(image: Blob, crop?: ImageCrop): Promise<User> {
    const u = (await this.multipartForm("PUT", "/api/users/@me/banner", imageForm(image, "banner", crop))) as User;
    this.apply("USER_UPDATE", publicUser(u));
    return u;
  }

  async removeBanner(): Promise<User> {
    const res = await fetch(this.url("/api/users/@me/banner"), { method: "DELETE", headers: this.authHeaders(), credentials: "include" });
    if (!res.ok) await this.throwApiError(res);
    const u = (await res.json()) as User;
    this.apply("USER_UPDATE", publicUser(u));
    return u;
  }

  /** Loads a voice channel's music: what plays and what is queued. */
  async loadMusic(channelId: string): Promise<MusicState> {
    const m = await unwrap(this.api.GET("/api/channels/{channelID}/music", { params: { path: { channelID: channelId } } }));
    this.apply("MUSIC_UPDATE", m);
    return m;
  }

  /** Queues a link or search, a library track or a saved playlist, in a voice channel the caller is in. */
  async queueMusic(channelId: string, what: QueueRequest): Promise<QueueResult> {
    return unwrap(this.api.POST("/api/channels/{channelID}/music", { params: { path: { channelID: channelId } }, body: what }));
  }

  async controlMusic(channelId: string, action: "pause" | "resume" | "skip" | "stop" | "shuffle") {
    await unwrap(this.api.POST("/api/channels/{channelID}/music/{action}", { params: { path: { channelID: channelId, action } } }));
  }

  async setMusicRepeat(channelId: string, mode: RepeatMode) {
    await unwrap(this.api.PUT("/api/channels/{channelID}/music/repeat", { params: { path: { channelID: channelId } }, body: { mode } }));
  }

  /** Loads what a voice channel watches together. */
  async getWatch(channelId: string): Promise<WatchUpdate> {
    const w = await unwrap(this.api.GET("/api/channels/{channelID}/watch", { params: { path: { channelID: channelId } } }));
    this.apply("WATCH_UPDATE", w);
    return w;
  }

  /** Starts watching a link together in a voice channel the caller is in, replacing what was on. */
  async startWatch(channelId: string, url: string) {
    this.apply("WATCH_UPDATE", await unwrap(this.api.POST("/api/channels/{channelID}/watch", { params: { path: { channelID: channelId } }, body: { url } })));
  }

  async watchPlay(channelId: string) {
    this.apply("WATCH_UPDATE", await unwrap(this.api.POST("/api/channels/{channelID}/watch/play", { params: { path: { channelID: channelId } } })));
  }

  async watchPause(channelId: string) {
    this.apply("WATCH_UPDATE", await unwrap(this.api.POST("/api/channels/{channelID}/watch/pause", { params: { path: { channelID: channelId } } })));
  }

  async watchSeek(channelId: string, position: number) {
    this.apply("WATCH_UPDATE", await unwrap(this.api.POST("/api/channels/{channelID}/watch/seek", { params: { path: { channelID: channelId } }, body: { position } })));
  }

  async stopWatch(channelId: string) {
    await unwrap(this.api.DELETE("/api/channels/{channelID}/watch", { params: { path: { channelID: channelId } } }));
  }

  /** Empties the queue; the current track plays on. */
  async clearMusicQueue(channelId: string) {
    await unwrap(this.api.DELETE("/api/channels/{channelID}/music/queue", { params: { path: { channelID: channelId } } }));
  }

  /** Loads the server's saved playlists into the store; events keep them current. */
  async loadPlaylists(): Promise<MusicPlaylist[]> {
    const list = (await unwrap(this.api.GET("/api/server/music/playlists"))) ?? [];
    this.set((s) => ({ ...s, playlists: Object.fromEntries(list.map((p) => [p.id, p])) }));
    return list;
  }

  async playlist(playlistId: string): Promise<PlaylistDetail> {
    return unwrap(this.api.GET("/api/server/music/playlists/{playlistID}", { params: { path: { playlistID: playlistId } } }));
  }

  /** Creates a playlist, empty or imported from a playlist link. */
  async createPlaylist(body: { title?: string; from_url?: string }) {
    const created = await unwrap(this.api.POST("/api/server/music/playlists", { body }));
    this.apply("MUSIC_PLAYLIST_UPDATE", created);
    return created;
  }

  async renamePlaylist(playlistId: string, title: string) {
    await unwrap(this.api.PATCH("/api/server/music/playlists/{playlistID}", { params: { path: { playlistID: playlistId } }, body: { title } }));
  }

  async deletePlaylist(playlistId: string) {
    await unwrap(this.api.DELETE("/api/server/music/playlists/{playlistID}", { params: { path: { playlistID: playlistId } } }));
    this.apply("MUSIC_PLAYLIST_DELETE", { id: playlistId });
  }

  async addToPlaylist(playlistId: string, what: PlaylistAdd): Promise<PlaylistAddResult> {
    return unwrap(this.api.POST("/api/server/music/playlists/{playlistID}/items", { params: { path: { playlistID: playlistId } }, body: what }));
  }

  async movePlaylistItem(playlistId: string, itemId: string, position: number) {
    await unwrap(this.api.PUT("/api/server/music/playlists/{playlistID}/items/{itemID}/position", {
      params: { path: { playlistID: playlistId, itemID: itemId } }, body: { position },
    }));
  }

  async removePlaylistItem(playlistId: string, itemId: string) {
    await unwrap(this.api.DELETE("/api/server/music/playlists/{playlistID}/items/{itemID}", {
      params: { path: { playlistID: playlistId, itemID: itemId } },
    }));
  }

  async unqueueMusic(channelId: string, trackId: string) {
    await unwrap(this.api.DELETE("/api/channels/{channelID}/music/queue/{trackID}", { params: { path: { channelID: channelId, trackID: trackId } } }));
  }

  /** Uploads an audio file to the server's music library. */
  async uploadMusic(file: Blob, title?: string): Promise<LibraryTrack> {
    const form = new FormData();
    form.append("file", file, file instanceof File ? file.name : "track");
    if (title) form.append("title", title);
    return (await this.multipartForm("POST", "/api/server/music", form)) as LibraryTrack;
  }

  /** Sets a role's icon to an emoji (Unicode, or custom:<id>); "" removes it. */
  async setRoleIconEmoji(roleId: string, icon_emoji: string): Promise<Role> {
    const r = await unwrap(this.api.PATCH("/api/server/roles/{roleID}", { params: { path: { roleID: roleId } }, body: { icon_emoji } }));
    this.apply("ROLE_UPDATE", r);
    return r;
  }

  /** Uploads an image as a role's icon, replacing any emoji. */
  async uploadRoleIcon(roleId: string, image: Blob): Promise<Role> {
    const form = new FormData();
    form.append("file", image, "icon");
    const r = (await this.multipartForm("PUT", `/api/server/roles/${roleId}/icon`, form)) as Role;
    this.apply("ROLE_UPDATE", r);
    return r;
  }

  /** Removes a role's icon, emoji or image. */
  async removeRoleIcon(roleId: string): Promise<Role> {
    const res = await fetch(this.url(`/api/server/roles/${roleId}/icon`), { method: "DELETE", headers: this.authHeaders(), credentials: "include" });
    if (!res.ok) await this.throwApiError(res);
    const r = (await res.json()) as Role;
    this.apply("ROLE_UPDATE", r);
    return r;
  }

  /** My 1:1 DM with a user: the existing one, or a new one. */
  async openDM(userId: string): Promise<Channel> {
    const existing = findDM(this.store.getState(), userId);
    if (existing) return this.store.getState().channels[existing]!;
    const ch = await unwrap(this.api.POST("/api/dms", { body: { recipient_ids: [userId] } }));
    this.apply("CHANNEL_CREATE", ch);
    return ch;
  }

  /** Leaves a group DM; the server deletes it once the last person is gone. */
  async leaveDM(channelId: string) {
    await unwrap(this.api.POST("/api/dms/{id}/leave", { params: { path: { id: channelId } } }));
    this.apply("CHANNEL_DELETE", { id: channelId });
  }

  private windowGen(channelId: string): number {
    return this.store.getState().messages[channelId]?.gen ?? 0;
  }

  /** Applies a loaded page unless the channel's window was replaced while the request was in flight. */
  private setIfCurrent(channelId: string, gen: number, fn: (s: State) => State) {
    this.set((s) => ((s.messages[channelId]?.gen ?? 0) === gen ? fn(s) : s));
  }

  /** Loads the next page of older messages (or the first page). */
  async loadOlder(channelId: string, limit = 50) {
    const gen = this.windowGen(channelId);
    const oldest = this.store.getState().messages[channelId]?.items.find((m) => !m.pending)?.id;
    const page = await unwrap(this.api.GET("/api/channels/{id}/messages", {
      params: { path: { id: channelId }, query: { limit, ...(oldest ? { before: oldest } : {}) } },
    }));
    this.setIfCurrent(channelId, gen, (s) => prependHistory(s, channelId, page ?? [], limit));
  }

  /** Replaces the loaded messages with a window around a message. */
  async loadAround(channelId: string, messageId: string, limit = 50) {
    const gen = this.windowGen(channelId);
    const page = await unwrap(this.api.GET("/api/channels/{id}/messages", {
      params: { path: { id: channelId }, query: { limit, around: messageId } },
    }));
    this.setIfCurrent(channelId, gen, (s) => replaceWindow(s, channelId, page ?? []));
  }

  /** Loads the next page of newer messages after a detached window. */
  async loadNewer(channelId: string, limit = 50) {
    const gen = this.windowGen(channelId);
    const newest = this.store.getState().messages[channelId]?.items.filter((m) => !m.pending).at(-1)?.id;
    const page = await unwrap(this.api.GET("/api/channels/{id}/messages", {
      params: { path: { id: channelId }, query: { limit, ...(newest ? { after: newest } : {}) } },
    }));
    this.setIfCurrent(channelId, gen, (s) => appendNewer(s, channelId, page ?? []));
  }

  /** Replaces the loaded messages with the latest page (leaves a detached window). */
  async loadLatest(channelId: string, limit = 50) {
    const gen = this.windowGen(channelId);
    const page = await unwrap(this.api.GET("/api/channels/{id}/messages", {
      params: { path: { id: channelId }, query: { limit } },
    }));
    this.setIfCurrent(channelId, gen, (s) => latestWindow(s, channelId, page ?? [], limit));
  }

  async search(q: string, cursor?: string): Promise<SearchResponse> {
    return unwrap(this.api.GET("/api/search", {
      params: { query: { q, utc_offset: -new Date().getTimezoneOffset(), ...(cursor ? { cursor } : {}) } },
    }));
  }

  /** Files in channels the caller can read (not DMs), newest first. */
  async files(p: FilesParams = {}): Promise<FilesPage> {
    const query: Record<string, string | number> = {};
    if (p.gallery) query.gallery = p.gallery;
    if (p.kinds?.length) query.kind = p.kinds.join(",");
    if (p.channels?.length) query.channel = p.channels.join(",");
    if (p.uploader) query.uploader = p.uploader;
    if (p.q) query.q = p.q;
    if (p.before) query.before = p.before;
    if (p.limit) query.limit = p.limit;
    return unwrap(this.api.GET("/api/files", { params: { query } }));
  }

  /** A gallery's albums the caller can see, most recently changed first, each with its deck. */
  async galleryAlbums(galleryId: string): Promise<Album[]> {
    return unwrap(this.api.GET("/api/channels/{id}/albums", { params: { path: { id: galleryId } } })) as Promise<Album[]>;
  }

  /** The albums the caller can add this file to (their gallery shows it); each says whether it holds it. */
  async albumsForFile(attachmentId: string): Promise<Album[]> {
    return unwrap(this.api.GET("/api/albums", { params: { query: { contains: attachmentId } } })) as Promise<Album[]>;
  }

  async album(id: string): Promise<Album> {
    return unwrap(this.api.GET("/api/albums/{albumID}", { params: { path: { albumID: id } } }));
  }

  async createAlbum(galleryId: string, body: { title: string; visibility: AlbumVisibility }): Promise<Album> {
    return unwrap(this.api.POST("/api/channels/{id}/albums", { params: { path: { id: galleryId } }, body }));
  }

  async updateAlbum(id: string, body: { title?: string; visibility?: AlbumVisibility }): Promise<Album> {
    return unwrap(this.api.PATCH("/api/albums/{albumID}", { params: { path: { albumID: id } }, body }));
  }

  async deleteAlbum(id: string): Promise<void> {
    await unwrap(this.api.DELETE("/api/albums/{albumID}", { params: { path: { albumID: id } } }));
  }

  async addAlbumMember(id: string, userId: string): Promise<void> {
    await unwrap(this.api.PUT("/api/albums/{albumID}/members/{userID}", { params: { path: { albumID: id, userID: userId } } }));
  }

  async removeAlbumMember(id: string, userId: string): Promise<void> {
    await unwrap(this.api.DELETE("/api/albums/{albumID}/members/{userID}", { params: { path: { albumID: id, userID: userId } } }));
  }

  /** An album's files the caller can see, newest upload first. */
  async albumFiles(id: string, p: Omit<FilesParams, "channels" | "gallery"> = {}): Promise<FilesPage> {
    const query: Record<string, string | number> = {};
    if (p.kinds?.length) query.kind = p.kinds.join(",");
    if (p.uploader) query.uploader = p.uploader;
    if (p.q) query.q = p.q;
    if (p.before) query.before = p.before;
    if (p.limit) query.limit = p.limit;
    return unwrap(this.api.GET("/api/albums/{albumID}/files", { params: { path: { albumID: id }, query } }));
  }

  async addToAlbum(id: string, attachmentId: string): Promise<void> {
    await unwrap(this.api.PUT("/api/albums/{albumID}/files/{attachmentID}", { params: { path: { albumID: id, attachmentID: attachmentId } } }));
  }

  async removeFromAlbum(id: string, attachmentId: string): Promise<void> {
    await unwrap(this.api.DELETE("/api/albums/{albumID}/files/{attachmentID}", { params: { path: { albumID: id, attachmentID: attachmentId } } }));
  }

  /** Where a library track's audio is served, for the browser's own player. */
  libraryAudioUrl(trackId: string): string {
    return this.url(`/api/music/tracks/${trackId}/audio`);
  }

  async loadMentions() {
    const page = await unwrap(this.api.GET("/api/users/@me/mentions", { params: { query: {} } }));
    this.set((s) => setMentions(s, page, false));
  }

  async loadOlderMentions() {
    const oldest = this.store.getState().mentions.items.at(-1)?.message.id;
    const page = await unwrap(this.api.GET("/api/users/@me/mentions", { params: { query: oldest ? { before: oldest } : {} } }));
    this.set((s) => setMentions(s, page, true));
  }

  async markMentionsRead() {
    const r = await unwrap(this.api.POST("/api/users/@me/mentions/ack"));
    this.set((s) => markMentionsRead(s, r.read_states ?? []));
  }

  async send(channelId: string, content: string, attachments: Attachment[] = [], replyTo?: ReplyRef, title?: string) {
    const nonce = crypto.randomUUID();
    this.set((s) => addPending(s, channelId, nonce, content, attachments, replyTo));
    try {
      const m = await unwrap(this.api.POST("/api/channels/{id}/messages", {
        params: { path: { id: channelId } },
        body: {
          content, nonce,
          ...(attachments.length > 0 ? { attachment_ids: attachments.map((a) => a.id) } : {}),
          ...(replyTo ? { reply_to_id: replyTo.id } : {}),
          ...(title ? { title } : {}),
        },
      }));
      // The gateway usually delivers this first; applying it twice is harmless.
      this.set((s) => applyEvent(s, "MESSAGE_CREATE", m));
    } catch (e) {
      this.set((s) => markFailed(s, channelId, nonce));
      throw e;
    }
  }

  async react(channelId: string, messageId: string, emoji: string) {
    await unwrap(this.api.PUT("/api/channels/{id}/messages/{messageID}/reactions/{emoji}", {
      params: { path: { id: channelId, messageID: messageId, emoji } },
    }));
  }

  async unreact(channelId: string, messageId: string, emoji: string) {
    await unwrap(this.api.DELETE("/api/channels/{id}/messages/{messageID}/reactions/{emoji}", {
      params: { path: { id: channelId, messageID: messageId, emoji } },
    }));
  }

  /** Posts a poll. It is not shown as pending: a poll appears once the server has it. */
  async sendPoll(channelId: string, poll: PollRequest, content = ""): Promise<Message> {
    const m = await unwrap(this.api.POST("/api/channels/{id}/messages", {
      params: { path: { id: channelId } },
      body: { content, poll },
    }));
    // The gateway usually delivers this first; applying it twice is harmless.
    this.set((s) => applyEvent(s, "MESSAGE_CREATE", m));
    return m;
  }

  /** Replaces my vote ([] removes it). The response is the only place my_votes comes from. */
  async votePoll(channelId: string, messageId: string, positions: number[]): Promise<Poll> {
    const poll = await unwrap(this.api.PUT("/api/channels/{id}/messages/{messageID}/poll/vote", {
      params: { path: { id: channelId, messageID: messageId } },
      body: { positions },
    }));
    this.set((s) => setPoll(s, channelId, messageId, poll));
    return poll;
  }

  /** Ends a poll early (its author, or MANAGE_MESSAGES). POLL_UPDATE brings the result. */
  async endPoll(channelId: string, messageId: string) {
    await unwrap(this.api.POST("/api/channels/{id}/messages/{messageID}/poll/end", {
      params: { path: { id: channelId, messageID: messageId } },
    }));
  }

  /** Who chose an answer of an open (not anonymous) poll. */
  async pollVoters(channelId: string, messageId: string, position: number): Promise<PublicUser[]> {
    return (await unwrap(this.api.GET("/api/channels/{id}/messages/{messageID}/poll/options/{n}/voters", {
      params: { path: { id: channelId, messageID: messageId, n: position } },
    }))) ?? [];
  }

  /** Adds a custom emoji (MANAGE_EXPRESSIONS). */
  async uploadEmoji(name: string, file: Blob): Promise<Emoji> {
    const form = new FormData();
    form.append("name", name);
    form.append("file", file, `${name}.img`);
    return (await this.multipartForm("POST", "/api/server/emoji", form)) as Emoji;
  }

  /** Searches 7TV's emotes (MANAGE_EXPRESSIONS); page starts at 1. */
  async searchSevenTV(q: string, page = 1): Promise<SevenTVPage> {
    return unwrap(this.api.GET("/api/server/emoji/7tv/search", { params: { query: { q, page } } }));
  }

  /** A 7TV emote set with its emotes (MANAGE_EXPRESSIONS). */
  async sevenTVSet(setId: string): Promise<SevenTVSet> {
    return unwrap(this.api.GET("/api/server/emoji/7tv/sets/{setID}", { params: { path: { setID: setId } } }));
  }

  /** Adds a 7TV emote as a custom emoji (MANAGE_EXPRESSIONS). */
  async importSevenTVEmote(emoteId: string, name: string): Promise<Emoji> {
    return unwrap(this.api.POST("/api/server/emoji/7tv", { body: { emote_id: emoteId, name } }));
  }

  async renameEmoji(id: string, name: string): Promise<Emoji> {
    return unwrap(this.api.PATCH("/api/server/emoji/{emojiID}", { params: { path: { emojiID: id } }, body: { name } }));
  }

  async deleteEmoji(id: string) {
    await unwrap(this.api.DELETE("/api/server/emoji/{emojiID}", { params: { path: { emojiID: id } } }));
  }

  /** Adds a soundboard sound (MANAGE_EXPRESSIONS). */
  async uploadSound(name: string, emoji: string, file: Blob): Promise<Sound> {
    const form = new FormData();
    form.append("name", name);
    form.append("emoji", emoji);
    form.append("file", file, `${name}.audio`);
    return (await this.multipartForm("POST", "/api/server/sounds", form)) as Sound;
  }

  async updateSound(id: string, patch: { name?: string; emoji?: string }): Promise<Sound> {
    return unwrap(this.api.PATCH("/api/server/sounds/{soundID}", { params: { path: { soundID: id } }, body: patch }));
  }

  async deleteSound(id: string) {
    await unwrap(this.api.DELETE("/api/server/sounds/{soundID}", { params: { path: { soundID: id } } }));
  }

  /** Plays a sound to the call you are in (USE_SOUNDBOARD, SPEAK). */
  async playSound(soundId: string) {
    await unwrap(this.api.POST("/api/voice/soundboard", { body: { sound_id: soundId } }));
  }

  /** The webhooks of a webhook channel (MANAGE_WEBHOOKS). Tokens are never listed. */
  async listWebhooks(channelId: string): Promise<Webhook[]> {
    return (await unwrap(this.api.GET("/api/channels/{id}/webhooks", { params: { path: { id: channelId } } }))) ?? [];
  }

  /** Creates a webhook. The answer holds its URL, which is shown this once. */
  async createWebhook(channelId: string, name: string): Promise<WebhookWithURL> {
    return unwrap(this.api.POST("/api/channels/{id}/webhooks", { params: { path: { id: channelId } }, body: { name } }));
  }

  async renameWebhook(id: string, name: string): Promise<Webhook> {
    return unwrap(this.api.PATCH("/api/webhooks/{id}", { params: { path: { id } }, body: { name } }));
  }

  async deleteWebhook(id: string) {
    await unwrap(this.api.DELETE("/api/webhooks/{id}", { params: { path: { id } } }));
  }

  /** Replaces a webhook's token; its old URL stops working. The answer holds the new URL, shown this once. */
  async regenerateWebhookToken(id: string): Promise<WebhookWithURL> {
    return unwrap(this.api.POST("/api/webhooks/{id}/token", { params: { path: { id } } }));
  }

  async uploadWebhookAvatar(id: string, image: Blob): Promise<Webhook> {
    return (await this.multipart("PUT", `/api/webhooks/${encodeURIComponent(id)}/avatar`, image, "avatar.png")) as Webhook;
  }

  async removeWebhookAvatar(id: string): Promise<Webhook> {
    const res = await fetch(this.url(`/api/webhooks/${encodeURIComponent(id)}/avatar`), {
      method: "DELETE", headers: this.authHeaders(), credentials: "include",
    });
    if (!res.ok) await this.throwApiError(res);
    return (await res.json()) as Webhook;
  }

  /** Uploads a file for a message in channelId; pass the result to send(). */
  async upload(channelId: string, file: Blob, filename: string): Promise<Attachment> {
    return (await this.multipart("POST", `/api/attachments?channel_id=${encodeURIComponent(channelId)}`, file, filename)) as Attachment;
  }

  /** The body of a file the server serves (an attachment), as text. */
  async fetchText(path: string): Promise<string> {
    const res = await fetch(this.url(path), { headers: this.authHeaders(), credentials: "include" });
    if (!res.ok) await this.throwApiError(res);
    return res.text();
  }

  private authHeaders(): Headers {
    const headers = new Headers();
    const token = this.o.token?.();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    else headers.set("X-Datrope-CSRF", "1");
    return headers;
  }

  private async multipart(method: string, path: string, file: Blob, filename: string): Promise<unknown> {
    const form = new FormData();
    form.append("file", file, filename);
    return this.multipartForm(method, path, form);
  }

  private async multipartForm(method: string, path: string, form: FormData): Promise<unknown> {
    const res = await fetch(this.url(path), { method, body: form, headers: this.authHeaders(), credentials: "include" });
    if (!res.ok) await this.throwApiError(res);
    return res.json();
  }

  private async throwApiError(res: Response): Promise<never> {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string; details?: Record<string, unknown> };
    throw new ApiError(res.status, body.code ?? "UNKNOWN", body.message ?? res.statusText, body.details);
  }

  /** Absolute URL for a server path such as an attachment's url. */
  url(path: string): string {
    return `${this.o.baseUrl}${path}`;
  }

  async ack(channelId: string, messageId: string) {
    const before = this.store.getState();
    this.set((s) => ackLocal(s, channelId, messageId));
    if (this.store.getState() === before) return; // already read
    await unwrap(this.api.POST("/api/channels/{id}/ack", { params: { path: { id: channelId } }, body: { message_id: messageId } }));
  }

  /** Tells others you are typing, at most every 8 seconds per channel. */
  async typing(channelId: string) {
    const now = Date.now();
    if ((this.lastTyping[channelId] ?? 0) > now - 8000) return;
    this.lastTyping[channelId] = now;
    await unwrap(this.api.POST("/api/channels/{id}/typing", { params: { path: { id: channelId } } }));
  }

  /** Asks to join a channel's (or DM's) voice; connect to LiveKit with the answer. */
  async joinVoice(channelId: string, self: { self_mute: boolean; self_deaf: boolean }): Promise<JoinVoiceResponse> {
    return unwrap(this.api.POST("/api/voice/{id}/join", { params: { path: { id: channelId } }, body: self }));
  }

  /** Tells others I muted or deafened myself (the muting itself happens locally). */
  async setVoiceSelf(patch: { self_mute?: boolean; self_deaf?: boolean }) {
    await unwrap(this.api.PATCH("/api/voice/state", { body: patch }));
  }

  async serverMute(userId: string, muted: boolean) {
    await unwrap(this.api.POST("/api/voice/members/{userID}/mute", { params: { path: { userID: userId } }, body: { muted } }));
  }

  async moveVoice(userId: string, channelId: string) {
    await unwrap(this.api.POST("/api/voice/members/{userID}/move", {
      params: { path: { userID: userId } }, body: { channel_id: channelId },
    }));
  }

  /** Takes a member (or myself) out of voice. */
  async disconnectVoice(userId: string) {
    await unwrap(this.api.DELETE("/api/voice/members/{userID}", { params: { path: { userID: userId } } }));
  }
}
