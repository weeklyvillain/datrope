import type { Panel } from "./panel";

export function panelToParam(p: Panel): string | null {
  if (!p) return null;
  switch (p.kind) {
    case "threads": case "search": return p.kind;
    case "thread": return p.parentId ? `thread:${p.threadId}:${p.parentId}` : `thread:${p.threadId}`;
    case "post": return `post:${p.postId}:${p.forumId}`;
    case "media": return `media:${p.attachmentId}`;
  }
}

export function paramToPanel(s: string | null): Panel {
  if (!s) return null;
  const [kind, a, b] = s.split(":");
  if (kind === "threads" || kind === "search") return { kind };
  if (kind === "thread" && a) return b ? { kind, threadId: a, parentId: b } : { kind, threadId: a };
  if (kind === "post" && a && b) return { kind, postId: a, forumId: b };
  if (kind === "media" && a) return { kind, attachmentId: a };
  return null;
}
