import { BookOpen, Hash, Images, Megaphone, MessagesSquare, Volume2, Webhook, type AnimatedIcon } from "@/components/icons";

export type CreatableChannelType = "text" | "voice" | "webhook" | "announcement" | "forum" | "gallery";

export const CHANNEL_TYPES: { value: CreatableChannelType; label: string; description: string; icon: AnimatedIcon }[] = [
  { value: "text", label: "Text", description: "Chat, share links and files.", icon: Hash },
  { value: "voice", label: "Voice", description: "Talk, share your screen and camera.", icon: Volume2 },
  { value: "webhook", label: "Webhook", description: "Only other apps post, through webhooks. Members reply in threads.", icon: Webhook },
  { value: "announcement", label: "Announcement", description: "Only moderators post. Everyone can react and reply.", icon: Megaphone },
  { value: "forum", label: "Forum", description: "Posts with a title and tags, each with its own replies.", icon: MessagesSquare },
  { value: "gallery", label: "Gallery", description: "A wall of photos, videos and files, from here or other channels.", icon: Images },
];

const ICONS: Record<string, AnimatedIcon> = {
  welcome: BookOpen,
  ...Object.fromEntries(CHANNEL_TYPES.map((t) => [t.value, t.icon])),
};

/** The sidebar and link-card icon for a channel type; Hash for anything else (dm, thread, unknown). */
export function channelIcon(type: string): AnimatedIcon {
  return ICONS[type] ?? Hash;
}

/** Types whose unread state shows in the sidebar. */
export function isUnreadType(type: string | undefined): boolean {
  return type === "text" || type === "webhook" || type === "announcement" || type === "forum" || type === "gallery";
}
