import { isGated, sidebarChannelIds, type State } from "@datrope/core";
import { Navigate, useParams } from "react-router-dom";
import { ServerIcon } from "@/components/logo";
import { lastVisited, useApp } from "../session";
import { AnnouncementView } from "./announcement/AnnouncementView";
import { ChannelView } from "./ChannelView";
import { ForumView } from "./forum/ForumView";
import { AlbumView } from "./gallery/AlbumView";
import { AlbumsView } from "./gallery/AlbumsView";
import { GalleryView } from "./gallery/GalleryView";
import { VoiceChannelView } from "./voice/VoiceChannelView";
import { EmptyView } from "./EmptyView";
import { WelcomeView } from "./welcome/WelcomeView";

/** Where "/" goes: the welcome channel while gated, else the last channel visited, else the first text channel. */
function homeChannel(s: State): string | undefined {
  const ids = sidebarChannelIds(s);
  if (isGated(s)) return ids.find((id) => s.channels[id]?.type === "welcome");
  const last = lastVisited("channel");
  if (last && ids.includes(last)) return last;
  return ids.find((id) => s.channels[id]?.type === "text") ?? ids[0];
}

/** Where leaving voice goes: the last channel visited that is not a voice channel, else the first text channel. */
export function textChannel(s: State): string | undefined {
  const ids = sidebarChannelIds(s);
  const last = lastVisited("text");
  if (last && ids.includes(last)) return last;
  return ids.find((id) => s.channels[id]?.type === "text");
}

export function Home() {
  const target = useApp(homeChannel);
  if (target) return <Navigate to={`/channels/${target}`} replace />;
  return (
    <EmptyView>
      <div className="grid justify-items-center gap-3">
        <ServerIcon size={64} />
        <p>No channels yet.</p>
      </div>
    </EmptyView>
  );
}

/** /gallery — files from every channel the viewer can read. */
export function GlobalGalleryRoute() {
  return <GalleryView scope={{ kind: "global" }} />;
}

/** /gallery/albums — the albums I can see. */
export function AlbumsRoute() {
  return <AlbumsView />;
}

/** /gallery/albums/:albumId — one album's files. */
export function AlbumRoute() {
  const { albumId = "" } = useParams();
  return <AlbumView key={albumId} albumId={albumId} />;
}

/** /channels/:channelId — a text, webhook, announcement, forum, gallery, voice or welcome channel. */
export function ChannelRoute() {
  const { channelId = "" } = useParams();
  const ch = useApp((s) => s.channels[channelId]);
  switch (ch?.type) {
    case "text":
    case "webhook":
      return <ChannelView key={channelId} channelId={channelId} members />;
    case "gallery":
      return <GalleryView key={channelId} scope={{ kind: "channel", channelId }} />;
    case "forum":
      return <ForumView key={channelId} channelId={channelId} />;
    case "announcement":
      return <AnnouncementView key={channelId} channelId={channelId} />;
    case "voice":
      return <VoiceChannelView key={channelId} channelId={channelId} />;
    case "welcome":
      return <WelcomeView key={channelId} channelId={channelId} />;
    case "dm":
      return <Navigate to={`/messages/${channelId}`} replace />;
    default:
      return <EmptyView>This channel is not available.</EmptyView>;
  }
}
