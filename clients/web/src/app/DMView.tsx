import { useParams } from "react-router-dom";
import { EmptyView } from "./EmptyView";
import { ChannelView } from "./ChannelView";
import { DMList } from "./DMList";
import { TopBar } from "./TopBar";
import { useIsMobile } from "@/hooks/use-mobile";

/** /messages/:channelId? — a conversation (the list lives in the sidebar's Messages tab; on phones, here). */
export function DMView() {
  const { channelId } = useParams();
  const mobile = useIsMobile();
  if (!channelId && mobile) {
    return (
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label="Direct messages">
        <TopBar><h2>Messages</h2></TopBar>
        <DMList />
      </main>
    );
  }
  return channelId
    ? <ChannelView key={channelId} channelId={channelId} />
    : <EmptyView>Pick a conversation or start a new one.</EmptyView>;
}
