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
export type Override = Schemas["Override"];
export type Attachment = Schemas["Attachment"];
export type Message = Schemas["Message"];
export type Emoji = Schemas["Emoji"];
export type Sound = Schemas["Sound"];
export type SoundboardPlay = Schemas["SoundboardPlay"];
export type Reaction = Schemas["Reaction"];
export type ReactionEvent = Schemas["ReactionEvent"];
export type ReplyRef = Schemas["ReplyRef"];
export type Embed = Schemas["Preview"];
export type Ready = Schemas["Ready"];
export type ReadState = Schemas["ReadState"];
export type Invite = Schemas["Invite"];
export type InvitePreview = Schemas["InvitePreview"];
export type ServerPreview = Schemas["ServerPreview"];
export type Session = Schemas["Session"];
export type Settings = Schemas["Settings"];
export type InstanceInfo = Schemas["InstanceInfo"];
export type Ban = Schemas["Ban"];
export type VoiceState = Schemas["VoiceState"];
export type VoiceMove = Schemas["VoiceMove"];
export type JoinVoiceResponse = Schemas["JoinResponse"];

export type ChannelRef = Schemas["ChannelRef"];
export type SearchResponse = Schemas["SearchResponse"];
export type SearchResult = Schemas["SearchResult"];
export type SearchFilters = Schemas["SearchFilters"];
export type MentionItem = Schemas["MentionItem"];
export type MentionsPage = Schemas["MentionsPage"];

export type PresenceStatus = "online" | "idle" | "invisible";

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
  EMOJI_UPDATE: Schemas["EmojiUpdate"];
  SOUND_UPDATE: Schemas["SoundUpdate"];
  SOUNDBOARD_PLAY: SoundboardPlay;
}
