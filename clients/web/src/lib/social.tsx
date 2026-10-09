import { Globe } from "lucide-react";
import type { ReactElement } from "react";
import { BrandIcon, hasBrandIcon } from "./brand-icons";

export type LinkInfo = { name: string; host: string; icon: string };

/** Known sites by host (a host or any subdomain of it matches). `icon` is a slug for a future glyph. */
const SITES: { hosts: string[]; name: string; icon: string }[] = [
  { hosts: ["github.com"], name: "GitHub", icon: "github" },
  { hosts: ["gitlab.com"], name: "GitLab", icon: "gitlab" },
  { hosts: ["youtube.com", "youtu.be"], name: "YouTube", icon: "youtube" },
  { hosts: ["twitch.tv"], name: "Twitch", icon: "twitch" },
  { hosts: ["steamcommunity.com"], name: "Steam", icon: "steam" },
  { hosts: ["x.com", "twitter.com"], name: "X", icon: "x" },
  { hosts: ["bsky.app"], name: "Bluesky", icon: "bluesky" },
  { hosts: ["instagram.com"], name: "Instagram", icon: "instagram" },
  { hosts: ["reddit.com"], name: "Reddit", icon: "reddit" },
  { hosts: ["open.spotify.com"], name: "Spotify", icon: "spotify" },
  { hosts: ["soundcloud.com"], name: "SoundCloud", icon: "soundcloud" },
  { hosts: ["tiktok.com"], name: "TikTok", icon: "tiktok" },
  { hosts: ["linkedin.com"], name: "LinkedIn", icon: "linkedin" },
  { hosts: ["discord.gg", "discord.com"], name: "Discord", icon: "discord" },
];

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
