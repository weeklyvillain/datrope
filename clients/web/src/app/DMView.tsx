import { useParams } from "react-router-dom";
import { EmptyView } from "./EmptyView";
import { ChannelView } from "./ChannelView";
import { DMList } from "./DMList";
import { useIsMobile } from "@/hooks/use-mobile";

/** /messages/:channelId? — a conversation (the list lives in the sidebar's Messages tab; on phones, here as the Messages tab root). */
export function DMView() {
  const { channelId } = useParams();
  const mobile = useIsMobile();
  if (!channelId && mobile) {
    return (
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label="Direct messages">
        <header className="flex min-h-[48px] flex-none items-center border-b bg-topbar px-4 pt-safe text-topbar-foreground">
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">Messages</h2>
        </header>
        <DMList />
      </main>
    );
  }
  return channelId
    ? <ChannelView key={channelId} channelId={channelId} />
    : <EmptyView>Pick a conversation or start a new one.</EmptyView>;
}
