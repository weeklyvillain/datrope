import type { Attachment } from "@datrope/core";
import { FileX } from "@/components/icons";
import { formatBytes } from "@/session";

/** A file the size rules (or someone) deleted: its name stays in the message, the contents are gone. */
export function ExpiredFile({ attachment: a }: { attachment: Attachment }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-lg border border-dashed bg-card px-3 py-2 text-muted-foreground">
      <FileX aria-hidden className="size-4" />
      <span className="line-through">{a.filename}</span>
      <span>{formatBytes(a.size)} · File expired</span>
    </span>
  );
}
