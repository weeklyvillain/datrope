import { ChannelsPane, ServerHeader } from "../ServerSidebar";

/** The phone Server tab root: the server header and the channel list. */
export function ServerHome() {
  return (
    <main aria-label="Server" className="flex min-h-0 min-w-0 flex-1 flex-col bg-sidebar">
      <div className="flex-none pt-safe px-safe"><ServerHeader /></div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-safe">
        <ChannelsPane />
      </div>
    </main>
  );
}
