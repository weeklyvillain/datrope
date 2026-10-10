/** A link that can play inline in chat: where its player lives and how big it is. */
export type Player = {
  site: "YouTube" | "Twitch" | "Spotify";
  icon: "youtube" | "twitch" | "spotify";
  /** The iframe URL. Twitch needs the page's host as `parent`, so it is filled in with the host given. */
  src: string;
  /** "video" is 16:9, "vertical" 9:16; a number is a fixed height in pixels (Spotify). */
  shape: "video" | "vertical" | number;
  label: string; // what it is, for the play button: "video", "live stream", "clip", "track", ...
};

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const TWITCH_NAME = /^[A-Za-z0-9_]{3,25}$/;
const TWITCH_RESERVED = new Set(["directory", "videos", "settings", "subscriptions", "inventory", "wallet", "downloads", "jobs", "p", "search", "turbo"]);
const SPOTIFY_KINDS = new Set(["track", "album", "playlist", "episode", "show", "artist"]);

function parse(url: string): URL | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}

/** "1h2m3s", "90s" or "90" as seconds. */
function seconds(t: string | null): number {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}

function youtube(u: URL, host: string): Player | undefined {
  let id: string | undefined;
  let vertical = false;
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    const [, first, second] = u.pathname.split("/");
    if (first === "watch") id = u.searchParams.get("v") ?? undefined;
    else if (first === "shorts" || first === "live" || first === "embed") {
      id = second;
      vertical = first === "shorts";
    }
  }
  if (!id || !YT_ID.test(id)) return undefined;
  const start = seconds(u.searchParams.get("t") ?? u.searchParams.get("start"));
  return {
    site: "YouTube", icon: "youtube", shape: vertical ? "vertical" : "video", label: vertical ? "short" : "video",
    src: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1${start ? `&start=${start}` : ""}`,
  };
}

function twitch(u: URL, host: string, parent: string): Player | undefined {
  const parts = u.pathname.split("/").filter(Boolean);
  const p = `&parent=${encodeURIComponent(parent)}`;
  const clip = (slug: string | undefined): Player | undefined => slug && /^[A-Za-z0-9_-]+$/.test(slug)
    ? { site: "Twitch", icon: "twitch", shape: "video", label: "clip", src: `https://clips.twitch.tv/embed?clip=${slug}${p}&autoplay=true` }
    : undefined;
  if (host === "clips.twitch.tv") return clip(parts[0]);
  if (host !== "twitch.tv" && host !== "m.twitch.tv") return undefined;
  if (parts[0] === "videos" && /^\d+$/.test(parts[1] ?? "")) {
    return { site: "Twitch", icon: "twitch", shape: "video", label: "video", src: `https://player.twitch.tv/?video=v${parts[1]}${p}&autoplay=true` };
  }
  if (parts.length === 3 && parts[1] === "clip") return clip(parts[2]);
  if (parts.length === 1 && TWITCH_NAME.test(parts[0]!) && !TWITCH_RESERVED.has(parts[0]!.toLowerCase())) {
    return { site: "Twitch", icon: "twitch", shape: "video", label: "live stream", src: `https://player.twitch.tv/?channel=${parts[0]}${p}&autoplay=true` };
  }
  return undefined;
}

function spotify(u: URL, host: string): Player | undefined {
  if (host !== "open.spotify.com") return undefined;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts[0]?.startsWith("intl-")) parts.shift();
  const [kind, id] = parts;
  if (!kind || !SPOTIFY_KINDS.has(kind) || !id || !/^[A-Za-z0-9]{22}$/.test(id)) return undefined;
  const small = kind === "track" || kind === "episode";
  return { site: "Spotify", icon: "spotify", shape: small ? 152 : 352, label: kind, src: `https://open.spotify.com/embed/${kind}/${id}` };
}

/** The inline player for a YouTube, Twitch or Spotify link, or undefined. `parent` is this page's host (Twitch needs it). */
export function playerFor(url: string, parent: string): Player | undefined {
  const u = parse(url);
  if (!u) return undefined;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  return youtube(u, host) ?? twitch(u, host, parent) ?? spotify(u, host);
}

const LINK = /https:\/\/[^\s<>()]+/g;

/** The player for the first playable link in a message, outside code. */
export function firstPlayer(content: string, parent: string): { url: string; player: Player } | undefined {
  const text = content.replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  for (const m of text.matchAll(LINK)) {
    const url = m[0].replace(/[.,!?;:'"]+$/, "");
    const player = playerFor(url, parent);
    if (player) return { url, player };
  }
  return undefined;
}
