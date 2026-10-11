import type { Attachment } from "@datrope/core";
import { useEffect, useState } from "react";
import { CodeBlock } from "@/components/code-block";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fileExtension, splitLines } from "@/lib/code";
import { client, formatBytes } from "@/session";
import { FileChip } from "./FileChip";

export const PREVIEW_LINES = 15;
export const MAX_PREVIEW_BYTES = 1_048_576;
// One huge minified line would otherwise render its whole length inline.
const MAX_PREVIEW_CHARS = 5_000;

/** Whether to preview the attachment as code: a text file small enough to fetch. */
export function isCodeFile(a: Attachment): boolean {
  return a.content_type.startsWith("text/") && a.size <= MAX_PREVIEW_BYTES;
}

/** A text file in a message: its first lines highlighted, the whole file in a dialog. */
export function CodeFileView({ attachment: a, text }: { attachment: Attachment; text: string | undefined }) {
  const [open, setOpen] = useState(false);
  const lang = fileExtension(a.filename);
  const title = (
    <>
      <span className="truncate text-foreground">{a.filename}</span>
      <span>{lang}</span>
      <span>{formatBytes(a.size)}</span>
    </>
  );
  const download = (
    <Button asChild variant="ghost" size="xs">
      <a href={client.url(a.url)} download={a.filename}>Download</a>
    </Button>
  );
  if (text === undefined) {
    return (
      <div className="w-[560px] max-w-full overflow-hidden rounded-lg border bg-sidebar" aria-busy="true">
        <div className="border-b bg-card px-3 py-1.5 text-xs text-muted-foreground">{a.filename}</div>
        <div className="h-24 animate-pulse bg-muted" />
      </div>
    );
  }
  const lines = splitLines(text);
  return (
    <div className="flex w-[560px] max-w-full flex-col items-start gap-1">
      <CodeBlock className="w-full" code={lines.slice(0, PREVIEW_LINES).join("\n").slice(0, MAX_PREVIEW_CHARS)} copyText={lines.join("\n")}
        lang={lang} title={title} actions={download} />
      {lines.length > PREVIEW_LINES && (
        <Button variant="link" size="xs" className="px-0" onClick={() => setOpen(true)}>Show all {lines.length} lines</Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{a.filename}</DialogTitle>
            <DialogDescription>{lines.length} lines · {formatBytes(a.size)}</DialogDescription>
          </DialogHeader>
          <CodeBlock className="max-h-[70vh] overflow-auto" code={lines.join("\n")} lang={lang} lineNumbers actions={download} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Fetches a text attachment and previews it; falls back to the download chip if that fails. */
export function CodeFileAttachment({ attachment: a }: { attachment: Attachment }) {
  const [text, setText] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    client.fetchText(a.url).then(
      (t) => live && setText(t),
      () => live && setFailed(true),
    );
    return () => { live = false; };
  }, [a.url]);
  if (failed) return <FileChip attachment={a} />;
  return <CodeFileView attachment={a} text={text} />;
}
