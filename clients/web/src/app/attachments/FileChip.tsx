import type { Attachment } from "@datrope/core";
import { client, formatBytes } from "@/session";

/** A download link for a file the chat does not show inline. */
export function FileChip({ attachment: a }: { attachment: Attachment }) {
  return (
    <a className="inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-foreground no-underline" href={client.url(a.url)} download={a.filename}>
      <span aria-hidden="true">📎</span>
      <span>{a.filename}</span>
      <span className="text-muted-foreground">{formatBytes(a.size)}</span>
    </a>
  );
}
