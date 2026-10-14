export type PhoneTab = "server" | "messages" | "mentions" | "you";
export const tabPath: Record<PhoneTab, string> = { server: "/", messages: "/messages", mentions: "/mentions", you: "/you" };

/** Which phone tab a page belongs to. */
export function tabFor(pathname: string): PhoneTab {
  if (pathname.startsWith("/messages")) return "messages";
  if (pathname.startsWith("/mentions")) return "mentions";
  if (pathname.startsWith("/you") || pathname.startsWith("/server-settings")) return "you";
  return "server";
}

/** Tab roots show the tab bar; every other page is a pushed screen with a back arrow. */
export function isTabRoot(pathname: string): boolean {
  return pathname === "/" || pathname === "/messages" || pathname === "/mentions" || pathname === "/you";
}
