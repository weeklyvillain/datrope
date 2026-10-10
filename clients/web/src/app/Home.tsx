import { isGated, sidebarChannelIds, type State } from "@datrope/core";
import { Navigate, useParams } from "react-router-dom";
import { ServerIcon } from "@/components/logo";
import { lastVisited, useApp } from "../session";
import { ChannelView } from "./ChannelView";
import { VoiceChannelView } from "./voice/VoiceChannelView";
import { WelcomeView } from "./welcome/WelcomeView";

/** Where "/" goes: the welcome channel while gated, else the last channel visited, else the first text channel. */
function homeChannel(s: State): string | undefined {
  const ids = sidebarChannelIds(s);
  if (isGated(s)) return ids.find((id) => s.channels[id]?.type === "welcome");
  const last = lastVisited("channel");
  if (last && ids.includes(last)) return last;
  return ids.find((id) => s.channels[id]?.type === "text") ?? ids[0];
}

export function Home() {
  const target = useApp(homeChannel);
  if (target) return <Navigate to={`/channels/${target}`} replace />;
  return (
    <main className="grid min-h-full min-w-0 flex-1 place-items-center bg-background p-8 text-center text-muted-foreground">
      <div className="grid justify-items-center gap-3">
        <ServerIcon size={64} />
        <p>No channels yet.</p>
      </div>
    </main>
  );
}

/** /channels/:channelId — a text, webhook, voice or welcome channel. */
export function ChannelRoute() {
  const { channelId = "" } = useParams();
  const ch = useApp((s) => s.channels[channelId]);
  switch (ch?.type) {
    case "text":
    case "webhook":
      return <ChannelView key={channelId} channelId={channelId} members />;
    case "voice":
      return <VoiceChannelView key={channelId} channelId={channelId} />;
    case "welcome":
      return <WelcomeView key={channelId} channelId={channelId} />;
    case "dm":
      return <Navigate to={`/messages/${channelId}`} replace />;
    default:
      return <main className="grid min-h-full min-w-0 flex-1 place-items-center bg-background p-8 text-center text-muted-foreground">This channel is not available.</main>;
  }
}
