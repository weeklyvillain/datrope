import { MentionsList } from "./MentionsList";

/** The Mentions tab: the same list as the desktop inbox popover, as a page. */
export function MentionsPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-12 flex-none items-center border-b bg-topbar px-4 pt-safe text-topbar-foreground">
        <h2 className="text-[15px] font-semibold">Mentions</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain"><MentionsList title={false} /></div>
    </div>
  );
}
