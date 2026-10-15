import { Globe } from "@/components/icons";
import type { ReactElement } from "react";
import { BrandIcon, hasBrandIcon } from "./brand-icons";

export type LinkInfo = { name: string; host: string; icon: string };

/** Known sites by host (a host or any subdomain of it matches). `prefix` starts a new link to a profile there. */
const SITES: { hosts: string[]; name: string; icon: string; prefix: string }[] = [
  { hosts: ["github.com"], name: "GitHub", icon: "github", prefix: "https://github.com/" },
  { hosts: ["gitlab.com"], name: "GitLab", icon: "gitlab", prefix: "https://gitlab.com/" },
  { hosts: ["youtube.com", "youtu.be"], name: "YouTube", icon: "youtube", prefix: "https://youtube.com/@" },
  { hosts: ["twitch.tv"], name: "Twitch", icon: "twitch", prefix: "https://twitch.tv/" },
  { hosts: ["kick.com"], name: "Kick", icon: "kick", prefix: "https://kick.com/" },
  { hosts: ["steamcommunity.com"], name: "Steam", icon: "steam", prefix: "https://steamcommunity.com/id/" },
  { hosts: ["itch.io"], name: "itch.io", icon: "itch", prefix: "https://itch.io/profile/" },
  { hosts: ["x.com", "twitter.com"], name: "X", icon: "x", prefix: "https://x.com/" },
  { hosts: ["bsky.app"], name: "Bluesky", icon: "bluesky", prefix: "https://bsky.app/profile/" },
  { hosts: ["threads.net", "threads.com"], name: "Threads", icon: "threads", prefix: "https://threads.net/@" },
  { hosts: ["instagram.com"], name: "Instagram", icon: "instagram", prefix: "https://instagram.com/" },
  { hosts: ["facebook.com"], name: "Facebook", icon: "facebook", prefix: "https://facebook.com/" },
  { hosts: ["tiktok.com"], name: "TikTok", icon: "tiktok", prefix: "https://tiktok.com/@" },
  { hosts: ["pinterest.com"], name: "Pinterest", icon: "pinterest", prefix: "https://pinterest.com/" },
  { hosts: ["reddit.com"], name: "Reddit", icon: "reddit", prefix: "https://reddit.com/user/" },
  { hosts: ["linkedin.com"], name: "LinkedIn", icon: "linkedin", prefix: "https://linkedin.com/in/" },
  { hosts: ["discord.gg", "discord.com"], name: "Discord", icon: "discord", prefix: "https://discord.gg/" },
  { hosts: ["t.me"], name: "Telegram", icon: "telegram", prefix: "https://t.me/" },
  { hosts: ["open.spotify.com"], name: "Spotify", icon: "spotify", prefix: "https://open.spotify.com/user/" },
  { hosts: ["soundcloud.com"], name: "SoundCloud", icon: "soundcloud", prefix: "https://soundcloud.com/" },
  { hosts: ["bandcamp.com"], name: "Bandcamp", icon: "bandcamp", prefix: "https://bandcamp.com/" },
  { hosts: ["patreon.com"], name: "Patreon", icon: "patreon", prefix: "https://patreon.com/" },
  { hosts: ["ko-fi.com"], name: "Ko-fi", icon: "kofi", prefix: "https://ko-fi.com/" },
  { hosts: ["letterboxd.com"], name: "Letterboxd", icon: "letterboxd", prefix: "https://letterboxd.com/" },
];

/** What a new link can start as, for the "Add link" menu: every known site, Mastodon (any server) and a plain website. */
export const PLATFORMS: { name: string; icon: string; prefix: string }[] = [
  ...SITES.map(({ name, icon, prefix }) => ({ name, icon, prefix })),
  { name: "Mastodon", icon: "mastodon", prefix: "https://" },
  { name: "Website", icon: "globe", prefix: "https://" },
];

/** True for a link that is only a platform's starting text, with nothing filled in. */
export const isBareLink = (url: string) => PLATFORMS.some((p) => p.prefix === url);

export type LinkIcon = (props: { className?: string }) => ReactElement;

/** The site's logo, or a globe. */
export const linkIcon = (icon: string): LinkIcon =>
  hasBrandIcon(icon) ? ({ className }) => <BrandIcon slug={icon} className={className} /> : ({ className }) => <Globe aria-hidden className={className} />;

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** True for a plain https:// URL with a host and no credentials; the only kind we render as a link. */
export function isHttpsLink(url: string): boolean {
  const u = parse(url);
  return !!u && u.protocol === "https:" && !!u.hostname && !u.username && !u.password;
}

/** The site name, shown host and icon for a link. Anything unknown is a "Website"; `/@name` paths elsewhere are Mastodon. */
export function describeLink(url: string): LinkInfo {
  const u = parse(url);
  const host = u?.hostname.toLowerCase() ?? url;
  const site = SITES.find((s) => s.hosts.some((h) => host === h || host.endsWith(`.${h}`)));
  if (site) return { name: site.name, host, icon: site.icon };
  if (u?.pathname.startsWith("/@")) return { name: "Mastodon", host, icon: "mastodon" };
  return { name: "Website", host, icon: "globe" };
}
