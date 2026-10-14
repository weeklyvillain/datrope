import { ApiError, emojiList, type Emoji as EmojiT, type SevenTVEmote } from "@datrope/core";
import { Smile, Trash2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useSubmit } from "@/hooks/use-submit";
import { client, displayName, errorText, useApp } from "@/session";
import { nameFromEmote, nameFromFile, validateNames } from "./emojiNames";
import { SevenTVDialog } from "./SevenTVDialog";
import { sizedImage } from "@/lib/sized-image";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

const MAX_EMOJI = 200;
const MAX_BYTES = 256 * 1024;
const TYPES = ["image/png", "image/gif", "image/webp"];

interface Tile {
  key: number;
  file?: File; // an upload
  emoteId?: string; // or a 7TV emote; url is its preview on 7TV's CDN
  url: string;
  name: string;
  fileError?: string; // the file itself is unusable
  serverError?: string; // from the last upload attempt; cleared when the name changes
}

let nextKey = 1;

/** Custom emoji (MANAGE_EXPRESSIONS): bulk upload (or 7TV import) with per-emoji names, plus the list of the server emoji with rename and delete. */
export function Emoji() {
  const emoji = useApp(useShallow(emojiList));
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sevenTV, setSevenTV] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;

  useEffect(() => () => tilesRef.current.forEach((t) => t.file && URL.revokeObjectURL(t.url)), []);

  const errors = validateNames(tiles, emoji.map((e) => e.name));
  const tileError = (t: Tile, i: number) => t.fileError ?? t.serverError ?? errors[i];
  // A server error from the last attempt is shown but does not block a retry (it may have been transient).
  const blocked = tiles.some((t, i) => t.fileError ?? errors[i]);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const added: Tile[] = Array.from(files).map((file) => ({
      key: nextKey++,
      file,
      url: URL.createObjectURL(file),
      name: nameFromFile(file.name),
      fileError: !TYPES.includes(file.type) ? "Use a PNG, GIF or WebP image" : file.size > MAX_BYTES ? "Larger than 256 KB" : undefined,
    }));
    setTiles((t) => [...t, ...added]);
  };

  const addEmotes = (emotes: SevenTVEmote[]) => {
    const staged = new Set(tilesRef.current.map((t) => t.emoteId));
    const added: Tile[] = emotes.filter((e) => !staged.has(e.id))
      .map((e) => ({ key: nextKey++, emoteId: e.id, url: e.preview_url, name: nameFromEmote(e.name) }));
    setTiles((t) => [...t, ...added]);
  };

  const drop = (keys: number[]) => {
    tilesRef.current.filter((t) => t.file && keys.includes(t.key)).forEach((t) => URL.revokeObjectURL(t.url));
    setTiles((ts) => ts.filter((t) => !keys.includes(t.key)));
  };

  const addAll = async () => {
    setUploading(true);
    for (const t of tilesRef.current.filter((x) => !x.fileError)) {
      try {
        await (t.file ? client.uploadEmoji(t.name, t.file) : client.importSevenTVEmote(t.emoteId!, t.name));
        drop([t.key]);
      } catch (e) {
        const msg = errorText(e);
        setTiles((ts) => ts.map((x) => (x.key === t.key ? { ...x, serverError: msg } : x)));
        if (e instanceof ApiError && e.code === "EMOJI_LIMIT") break;
      }
    }
    setUploading(false);
  };

  return (
    <>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-muted-foreground">Custom emoji everyone on the server can use in messages and reactions.</p>
          <p className="mt-1 text-xs text-muted-foreground">{emoji.length} of {MAX_EMOJI} used</p>
        </div>
        <Button variant="outline" onClick={() => setSevenTV(true)}>Add from 7TV</Button>
        <Button onClick={() => picker.current?.click()}><Upload aria-hidden />Upload emoji</Button>
        <input ref={picker} type="file" multiple accept="image/png,image/gif,image/webp" aria-label="Choose emoji images" className="hidden"
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
      </div>

      {tiles.length > 0 && (
        <section aria-label="New emoji" className="grid gap-3 rounded-lg border bg-card p-4">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold">{tiles.length} new emoji</h3>
              <p className="text-xs text-muted-foreground">Names can use letters, digits and underscores. People type :name: to use them.</p>
            </div>
            <Button variant="outline" disabled={uploading} onClick={() => drop(tiles.map((t) => t.key))}>Clear</Button>
            <Button disabled={blocked || uploading} onClick={addAll}>Add all</Button>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
            {tiles.map((t, i) => {
              const err = tileError(t, i);
              return (
                <div key={t.key} className="relative grid gap-2 rounded-md border bg-background p-3">
                  <Button variant="ghost" size="icon-xs" className="absolute top-1 right-1" aria-label={`Remove ${t.name}`}
                    disabled={uploading} onClick={() => drop([t.key])}><X aria-hidden /></Button>
                  <img src={t.url} loading="lazy" alt="" className="mx-auto size-12 object-contain" />
                  <div className="flex items-center gap-1 text-muted-foreground">
                    :<Input value={t.name} aria-label={`Name for emoji ${i + 1}`} aria-invalid={err ? true : undefined}
                      className="h-8 px-2 font-mono text-title md:text-sm" disabled={uploading}
                      onChange={(e) => setTiles((ts) => ts.map((x) => (x.key === t.key ? { ...x, name: e.target.value, serverError: undefined } : x)))} />:
                  </div>
                  {err && <p className="text-xs text-destructive" role="alert">{err}</p>}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {sevenTV && <SevenTVDialog onAdd={addEmotes} onClose={() => setSevenTV(false)} />}
      <ServerEmoji emoji={emoji} />
    </>
  );
}

function ServerEmoji({ emoji }: { emoji: EmojiT[] }) {
  const members = useApp((s) => s.server?.members);
  const [query, setQuery] = useState("");
  const [toDelete, setToDelete] = useState<EmojiT>();
  useEffect(() => { client.loadMembers().catch(() => undefined); }, []);
  const shown = emoji.filter((e) => e.name.toLowerCase().includes(query.trim().toLowerCase()));
  const creator = (e: EmojiT) => {
    const m = e.creator_id ? members?.[e.creator_id] : undefined;
    return m ? displayName(m.user) : "Someone";
  };
  return (
    <section aria-label="Server emoji" className="grid gap-3">
      <Input type="search" aria-label="Search emoji" placeholder="Search emoji" value={query} onChange={(e) => setQuery(e.target.value)} className="max-w-xs" />
      {emoji.length === 0 ? <Empty><EmptyHeader><EmptyMedia variant="icon"><Smile /></EmptyMedia><EmptyTitle>No custom emoji yet</EmptyTitle><EmptyDescription>Upload one to use it in chat.</EmptyDescription></EmptyHeader></Empty>
        : shown.length === 0 ? <p className="text-muted-foreground">No emoji match.</p> : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Image</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Added by</TableHead>
                <TableHead><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((e) => (
                <TableRow key={e.id}>
                  <TableCell><img {...sizedImage(e.url, 32)} loading="lazy" alt="" className="size-8 object-contain" /></TableCell>
                  <TableCell><RenameField key={e.name} emoji={e} /></TableCell>
                  <TableCell className="text-muted-foreground">{creator(e)}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon-sm" aria-label={`Delete :${e.name}:`} onClick={() => setToDelete(e)}><Trash2 aria-hidden /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      {toDelete && <DeleteDialog emoji={toDelete} onClose={() => setToDelete(undefined)} />}
    </section>
  );
}

/** The :name: cell: edits in place and saves on blur or Enter. */
function RenameField({ emoji }: { emoji: EmojiT }) {
  const [name, setName] = useState(emoji.name);
  const { error, run } = useSubmit();
  const save = () => {
    const next = name.trim();
    if (next === emoji.name) { setName(emoji.name); return; }
    void run(async () => { await client.renameEmoji(emoji.id, next); });
  };
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-1 font-mono text-sm text-muted-foreground">
        :<Input value={name} aria-label={`Rename :${emoji.name}:`} aria-invalid={error ? true : undefined} className="h-8 w-44 px-2 font-mono text-title md:text-sm text-foreground"
          onChange={(e) => setName(e.target.value)} onBlur={save}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />:
      </div>
      <ErrorText error={error} />
    </div>
  );
}

function DeleteDialog({ emoji, onClose }: { emoji: EmojiT; onClose: () => void }) {
  const { busy, error, run } = useSubmit();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Delete :${emoji.name}:?`}</DialogTitle>
          <DialogDescription>{`Messages will show :${emoji.name}: as text and its reactions will be removed.`}</DialogDescription>
        </DialogHeader>
        <ErrorText error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={() => run(async () => { await client.deleteEmoji(emoji.id); onClose(); })}>Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
