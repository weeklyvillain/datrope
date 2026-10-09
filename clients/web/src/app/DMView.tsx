import { useParams } from "react-router-dom";
import { ChannelView } from "./ChannelView";

/** /messages/:channelId? — a conversation (the list lives in the sidebar's Messages tab). */
export function DMView() {
  const { channelId } = useParams();
  return channelId
    ? <ChannelView key={channelId} channelId={channelId} />
    : <main className="grid min-h-full min-w-0 flex-1 place-items-center bg-background p-8 text-center text-muted-foreground">Pick a conversation or start a new one.</main>;
}
