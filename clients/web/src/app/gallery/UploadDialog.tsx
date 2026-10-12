import { File as FileIcon, Film, ImagePlus, Loader2, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { client, errorText, formatBytes } from "../../session";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { useSubmit } from "@/hooks/use-submit";
import { MAX_FILES, useUploads, type PendingFile } from "@/hooks/use-uploads";
import { cn } from "@/lib/utils";
import { attachmentImage } from "@/lib/sized-image";

const MAX_LENGTH = 4000;

/** Uploads files to a channel gallery as one message, or straight into an album. */
export function UploadDialog({ target, onClose }: { target: { channelId: string } | { albumId: string }; onClose: () => void }) {
  return "albumId" in target ? <AlbumUpload albumId={target.albumId} onClose={onClose} />
    : <ChannelUpload channelId={target.channelId} onClose={onClose} />;
}

/** Uploads files to a gallery as one message, with an optional caption. */
function ChannelUpload({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const id = useId();
  const [caption, setCaption] = useState("");
  const [invalid, setInvalid] = useState<string>();
  const picker = useRef<HTMLInputElement>(null);
  const uploads = useUploads(channelId, { onError: setInvalid });
  const { files, uploading, ready } = uploads;
  const failed = files.some((f) => f.error);
  const { busy, error, run } = useSubmit();

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Upload files</DialogTitle>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await client.send(channelId, caption.trim(), ready);
            onClose();
          });
        }}>
          <Field>
            <input ref={picker} type="file" multiple hidden
              onChange={(e) => {
                setInvalid(undefined);
                if (e.target.files) uploads.add(Array.from(e.target.files));
                e.target.value = "";
              }} />
            <Button variant="outline" className="w-fit" disabled={files.length >= MAX_FILES} onClick={() => picker.current?.click()}>
              <ImagePlus /> Choose files
            </Button>
            <FieldDescription>Up to {MAX_FILES} files.</FieldDescription>
          </Field>
          {files.length > 0 && (
            <ul className="m-0 grid list-none gap-2 p-0" aria-label="Files">
              {files.map((f) => <FileRow key={f.key} file={f} onRemove={() => uploads.remove(f.key)} />)}
            </ul>
          )}
          <Field>
            <FieldLabel htmlFor={`${id}-caption`}>Caption</FieldLabel>
            <Textarea id={`${id}-caption`} className="min-h-20" value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={MAX_LENGTH} />
          </Field>
          <ErrorText error={invalid ?? error} />
          {failed && <p className="m-0 text-sm text-muted-foreground">Remove the files that failed to upload.</p>}
          <DialogFooter>
            <Button type="submit" disabled={busy || uploading || failed || ready.length === 0}>Upload</Button>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type AlbumFile = { key: string; name: string; size: number; done: boolean; error?: string };

function AlbumUpload({ albumId, onClose }: { albumId: string; onClose: () => void }) {
  const picker = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<AlbumFile[]>([]);
  const busy = files.some((f) => !f.done && !f.error);
  const add = (list: File[]) => {
    const fresh = list.map((f) => ({ key: `${f.name}-${f.size}-${Math.random()}`, name: f.name, size: f.size, done: false }));
    setFiles((cur) => [...cur, ...fresh]);
    // three at a time, so a 200-photo dump doesn't open 200 requests
    let next = 0;
    const work = async () => {
      while (next < list.length) {
        const i = next++;
        const k = fresh[i].key;
        try {
          await client.uploadToAlbum(albumId, list[i], list[i].name);
          setFiles((cur) => cur.map((f) => (f.key === k ? { ...f, done: true } : f)));
        } catch (e) {
          setFiles((cur) => cur.map((f) => (f.key === k ? { ...f, error: errorText(e) } : f)));
        }
      }
    };
    void Promise.all([work(), work(), work()]);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader><DialogTitle>Upload to album</DialogTitle></DialogHeader>
        <input ref={picker} type="file" multiple hidden onChange={(e) => { if (e.target.files) add(Array.from(e.target.files)); e.target.value = ""; }} />
        <Button variant="outline" className="w-fit" onClick={() => picker.current?.click()}><ImagePlus /> Choose files</Button>
        {files.length > 0 && (
          <ul className="m-0 grid list-none gap-1 p-0 text-sm" aria-label="Files">
            {files.map((f) => (
              <li key={f.key} className={cn("flex justify-between gap-3 rounded-md border bg-card px-2 py-1.5", f.error && "border-destructive")}>
                <span className="truncate">{f.name}</span>
                <span className={cn("flex-none text-xs", f.error ? "text-destructive" : "text-muted-foreground")}>
                  {f.error ?? (f.done ? formatBytes(f.size) : "Uploading…")}
                </span>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter><Button onClick={onClose} disabled={busy}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FileRow({ file: f, onRemove }: { file: PendingFile; onRemove: () => void }) {
  const a = f.attachment;
  const status = f.error ?? (a ? formatBytes(f.size) : "Uploading…");
  return (
    <li className={cn("flex items-center gap-3 rounded-md border bg-card p-2 text-sm", f.error && "border-destructive")}>
      <span className="grid size-12 flex-none place-items-center overflow-hidden rounded bg-muted text-muted-foreground" aria-hidden>
        {!a ? (f.error ? <X className="size-4" /> : <Loader2 className="size-4 animate-spin" />)
          : a.content_type.startsWith("image/") ? <img {...attachmentImage(a, 48, { cover: true })} alt="" className="size-full object-cover" />
          : a.thumbnail_url ? <img src={client.url(a.thumbnail_url)} alt="" className="size-full object-cover" />
          : a.content_type.startsWith("video/") ? <Film className="size-4" />
          : <FileIcon className="size-4" />}
      </span>
      <span className="grid min-w-0 flex-1">
        <span className="truncate">{f.name}</span>
        <span className={cn("text-xs", f.error ? "text-destructive" : "text-muted-foreground")}>{status}</span>
      </span>
      <Button variant="ghost" size="icon-xs" aria-label={`Remove ${f.name}`} onClick={onRemove}><X /></Button>
    </li>
  );
}