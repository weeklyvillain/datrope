import type { components } from "./schema";

export type Schemas = components["schemas"];
export type User = Schemas["User"];
export type PublicUser = Schemas["PublicUser"];
export type Server = Schemas["Server"];
export type ServerWithRoles = Schemas["ServerWithRoles"];
export type Welcome = Schemas["Welcome"];
export type Role = Schemas["Role"];
export type Member = Schemas["Member"];
export type Category = Schemas["Category"];
export type ThreadSummary = Schemas["ThreadSummary"];
export type ThreadUpdate = Schemas["ThreadUpdate"];
export type ThreadListItem = Schemas["ThreadListItem"];
export type Channel = Schemas["Channel"];
export type ChannelType = Channel["type"];
/** POST_UPDATE payload: a forum post was created or changed. */
export interface PostUpdate { channel_id: string; post: ThreadListItem }
/** POST_DELETE payload: a forum post was deleted. */
export interface PostDeleted { channel_id: string; id: string }
export type Override = Schemas["Override"];
export type Attachment = Schemas["Attachment"];
export type GIF = Schemas["GIF"];
export type GIFPage = Schemas["GIFPage"];
export type Message = Schemas["Message"];
export type Emoji = Schemas["Emoji"];
export type SevenTVEmote = Schemas["SevenTVEmote"];
export type SevenTVPage = Schemas["SevenTVPage"];
export type SevenTVSet = Schemas["SevenTVSet"];
export type Sound = Schemas["Sound"];
export type SoundboardPlay = Schemas["SoundboardPlay"];
export type Reaction = Schemas["Reaction"];
export type ReactionEvent = Schemas["ReactionEvent"];
export type ReplyRef = Schemas["ReplyRef"];
export type Poll = Schemas["Poll"];
export type PollOption = Schemas["PollOption"];
export type PollRequest = Schemas["PollRequest"];
export type PollUpdate = Schemas["PollUpdate"];
export type Embed = Schemas["Preview"]; // a link preview
export type WebhookAuthor = Schemas["WebhookAuthor"];
/** A rich embed a webhook posted (Message.embeds); not the link preview (Embed). */
export type WebhookEmbed = Schemas["WebhookEmbed"];
export type EmbedField = Schemas["EmbedField"];
export type Webhook = Schemas["Webhook"];
export type WebhookWithURL = Schemas["WebhookWithURL"];
export type Ready = Schemas["Ready"];
export type ReadState = Schemas["ReadState"];
export type Invite = Schemas["Invite"];
export type InvitePreview = Schemas["InvitePreview"];
export type ServerPreview = Schemas["ServerPreview"];
export type Session = Schemas["Session"];
export type Settings = Schemas["Settings"];
export type InstanceInfo = Schemas["InstanceInfo"];
export type Ban = Schemas["Ban"];
export type AuditEntry = Schemas["LogEntry"];
export type AuditChange = Schemas["LogChange"];
export type VoiceState = Schemas["VoiceState"];
export type VoiceMove = Schemas["VoiceMove"];
export type JoinVoiceResponse = Schemas["JoinResponse"];

export type ChannelRef = Schemas["ChannelRef"];
export type SearchResponse = Schemas["SearchResponse"];
export type SearchResult = Schemas["SearchResult"];
export type SearchFilters = Schemas["SearchFilters"];
export type MentionItem = Schemas["MentionItem"];
export type MentionsPage = Schemas["MentionsPage"];
export type FileItem = Schemas["FileItem"];
export type FilesPage = Schemas["FilesPage"];
export type FileKind = FileItem["kind"];
export type Album = Schemas["Album"];
export type AlbumVisibility = Album["visibility"];

export type PresenceStatus = "online" | "idle" | "invisible";
export type Activity = Schemas["Activity"];
export type StreamAlert = Schemas["StreamAlert"];
export type Connection = Schemas["Connection"];
export type MusicState = Schemas["MusicState"];
export type MusicTrack = Schemas["MusicTrack"];
export type LibraryTrack = Schemas["LibraryTrack"];
export type Library = Schemas["Library"];
export type QueueRequest = Schemas["QueueRequest"];
export type QueueResult = Schemas["QueueResult"];
export type RepeatMode = Schemas["RepeatRequest"]["mode"];
export type MusicPlaylist = Schemas["MusicPlaylist"];
export type PlaylistItem = Schemas["PlaylistItem"];
export type PlaylistDetail = Schemas["PlaylistDetail"];
export type PlaylistAdd = Schemas["PlaylistAdd"];
export type PlaylistAddResult = Schemas["PlaylistAddResult"];

/** Gateway DISPATCH payloads by event type. */
export interface EventMap {
  MESSAGE_CREATE: Message;
  MESSAGE_UPDATE: Message;
  MESSAGE_DELETE: Schemas["MessageDeleted"];
  TYPING_START: Schemas["TypingStart"];
  CHANNEL_CREATE: Channel;
  CHANNEL_UPDATE: Channel;
  CHANNEL_DELETE: Schemas["ChannelDeleted"];
  CATEGORY_CREATE: Category;
  CATEGORY_UPDATE: Category;
  CATEGORY_DELETE: Schemas["CategoryDeleted"];
  THREAD_UPDATE: ThreadUpdate;
  POST_UPDATE: PostUpdate;
  POST_DELETE: PostDeleted;
  SERVER_UPDATE: Server;
  WELCOME_UPDATE: Welcome;
  MEMBER_ADD: Member;
  MEMBER_UPDATE: Member;
  MEMBER_REMOVE: Schemas["MemberRemoved"];
  ROLE_CREATE: Role;
  ROLE_UPDATE: Role;
  ROLE_DELETE: Schemas["RoleDeleted"];
  PRESENCE_UPDATE: Schemas["PresenceUpdate"];
  USER_UPDATE: PublicUser;
  VOICE_STATE_UPDATE: VoiceState;
  VOICE_MOVE: VoiceMove;
  MESSAGE_REACTION_ADD: ReactionEvent;
  MESSAGE_REACTION_REMOVE: ReactionEvent;
  POLL_UPDATE: PollUpdate;
  EMOJI_UPDATE: Schemas["EmojiUpdate"];
  SOUND_UPDATE: Schemas["SoundUpdate"];
  SOUNDBOARD_PLAY: SoundboardPlay;
  ACTIVITY_UPDATE: Schemas["ActivityUpdate"];
  MUSIC_UPDATE: Schemas["MusicState"];
  MUSIC_PLAYLIST_UPDATE: Schemas["MusicPlaylist"];
  MUSIC_PLAYLIST_DELETE: Schemas["PlaylistDeleted"];
}

export type SystemStats = Schemas["SystemStats"];
export type SystemSample = Schemas["SystemSample"];
export type HostStats = Schemas["HostStats"];
export type ContainerInfo = Schemas["ContainerInfo"];
export type SystemUpdates = Schemas["SystemUpdates"];
export type YtDlpStatus = Schemas["YtDlpStatus"];
export type GitStatus = Schemas["GitStatus"];
export type GitCommit = Schemas["GitCommit"];
export type UpdateJobLog = Schemas["UpdateJobLog"];
