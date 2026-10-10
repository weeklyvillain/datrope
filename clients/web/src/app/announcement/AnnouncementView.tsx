import { ChannelView } from "../ChannelView";

/** An announcement channel: titled post cards in a centred column; only members who may post get the composer. */
export function AnnouncementView({ channelId }: { channelId: string }) {
  return <ChannelView channelId={channelId} members kind="announcement" />;
}
