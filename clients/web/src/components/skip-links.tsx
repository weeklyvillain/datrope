const link = "sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-popover focus:px-3 focus:py-2 focus:text-popover-foreground focus:ring-2 focus:ring-ring";

/** First stops in the tab order: jump past the sidebar to the messages or the composer. */
export function SkipLinks() {
  const go = (selector: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    // The virtualized message list shows its rows a few frames after it mounts (hidden until it has scrolled).
    const focus = (tries: number) => {
      const el = document.querySelector<HTMLElement>(selector);
      el?.focus();
      if ((!el || document.activeElement !== el) && tries > 0) requestAnimationFrame(() => focus(tries - 1));
    };
    focus(30);
  };
  return (
    <div className="contents">
      <a href="#messages" className={link} onClick={go('[data-message-row][tabindex="0"]')}>Skip to messages</a>
      <a href="#composer" className={link} onClick={go('textarea[aria-label="Message"]')}>Skip to composer</a>
    </div>
  );
}
