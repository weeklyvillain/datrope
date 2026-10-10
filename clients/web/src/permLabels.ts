import { Perm } from "@datrope/core";

/**
 * Every permission, in display order, with a one-line description in plain words.
 * `channel` = meaningful in a channel override.
 */
export const PERM_LABELS: { flag: number; label: string; description: string; channel: boolean }[] = [
  { flag: Perm.ViewChannel, label: "View channels", description: "See channels and what is posted in them.", channel: true },
  { flag: Perm.SendMessages, label: "Send messages", description: "Post messages in text channels.", channel: true },
  { flag: Perm.AttachFiles, label: "Attach files", description: "Upload images and files with their messages.", channel: true },
  { flag: Perm.ReadHistory, label: "Read message history", description: "See messages sent before they opened the channel.", channel: true },
  { flag: Perm.ConnectVoice, label: "Connect to voice", description: "Join voice channels.", channel: true },
  { flag: Perm.Speak, label: "Speak", description: "Talk in voice channels.", channel: true },
  { flag: Perm.Stream, label: "Video and screen share", description: "Turn on a camera or share a screen in voice.", channel: true },
  { flag: Perm.MentionEveryone, label: "Mention @everyone", description: "Ping everyone who can read the channel with @everyone.", channel: true },
  { flag: Perm.ManageMessages, label: "Manage messages", description: "Delete other people's messages.", channel: true },
  { flag: Perm.MuteMembers, label: "Mute members", description: "Mute people in voice for everyone.", channel: true },
  { flag: Perm.MoveMembers, label: "Move members", description: "Move people between voice channels or disconnect them.", channel: true },
  { flag: Perm.Kick, label: "Kick members", description: "Remove people from the server. They can come back with a new invite.", channel: false },
  { flag: Perm.Ban, label: "Ban members", description: "Remove people from the server for good. They cannot come back until unbanned.", channel: false },
  { flag: Perm.CreateInvite, label: "Create invites", description: "Make invite links to bring people in.", channel: false },
  { flag: Perm.ManageRoles, label: "Manage roles and permissions", description: "Create, edit and hand out roles below their own.", channel: true },
  { flag: Perm.ManageChannels, label: "Manage channels", description: "Create, rename, reorder and delete channels.", channel: true },
  { flag: Perm.ManageServer, label: "Manage server", description: "Change the server's name, look and welcome page.", channel: false },
  { flag: Perm.AddReactions, label: "Add reactions", description: "React to messages with emoji.", channel: true },
  { flag: Perm.CreateThreads, label: "Create threads", description: "Start threads off a message.", channel: true },
  { flag: Perm.UseSoundboard, label: "Use soundboard", description: "Play soundboard sounds in voice.", channel: true },
  { flag: Perm.ManageExpressions, label: "Manage emoji and sounds", description: "Add, rename and remove custom emoji and soundboard sounds.", channel: false },
  { flag: Perm.ManageWebhooks, label: "Manage webhooks", description: "Add, rename and delete the webhooks of webhook channels, and get their URLs.", channel: true },
  { flag: Perm.Admin, label: "Administrator (every permission)", description: "Every permission, in every channel, whatever the channel settings say.", channel: false },
];

/** Permissions grouped for the role editor. Every flag in PERM_LABELS appears exactly once. */
export const PERM_GROUPS: { title: string; flags: number[] }[] = [
  { title: "General", flags: [Perm.ViewChannel, Perm.CreateInvite] },
  {
    title: "Text",
    flags: [Perm.SendMessages, Perm.AttachFiles, Perm.ReadHistory, Perm.AddReactions, Perm.CreateThreads, Perm.MentionEveryone, Perm.ManageMessages],
  },
  { title: "Voice", flags: [Perm.ConnectVoice, Perm.Speak, Perm.Stream, Perm.UseSoundboard, Perm.MuteMembers, Perm.MoveMembers] },
  { title: "Moderation", flags: [Perm.Kick, Perm.Ban] },
  { title: "Server", flags: [Perm.ManageChannels, Perm.ManageRoles, Perm.ManageWebhooks, Perm.ManageExpressions, Perm.ManageServer, Perm.Admin] },
];
