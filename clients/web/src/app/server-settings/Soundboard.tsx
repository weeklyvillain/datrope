import { soundList, type Sound } from "@datrope/core";
import { Play, Trash2, Upload } from "@/components/icons";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { EmojiPicker } from "@/chat/EmojiPicker";
import { ErrorText } from "@/components/error-text";
import { RefButton } from "@/components/ref-button";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useSubmit } from "@/hooks/use-submit";
import { client, displayName, useApp } from "@/session";
import { voicePrefs } from "@/voice/prefs";
import { playClip } from "@/voice/soundboard-audio";
import { checkSoundFile } from "./soundCheck";

const MAX_SOUNDS = 100;
const DEFAULT_EMOJI = "\u{1F50A}"; // speaker

/** A sound name from its file name: no extension, at most 32 characters. */
const nameFromFile = (filename: string) => filename.replace(/\.[^.]*$/, "").trim().slice(0, 32);

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

// Previews and Play use the soundboard volume of the person using this page.
const play = (url: string, durationMs?: number) => playClip(url, voicePrefs.getState().soundboardVolume, durationMs);

/** Soundboard sounds (MANAGE_EXPRESSIONS): add a sound, and the list of the server sounds with rename, emoji change, preview and delete. */
export function Soundboard() {
  const sounds = useApp(useShallow(soundList));
  return (
    <>
      <div className="min-w-0">
        <p className="text-muted-foreground">Short sounds anyone in a call can play. Up to 5 seconds each.</p>
        <p className="mt-1 text-xs text-muted-foreground">{sounds.length} of {MAX_SOUNDS} used</p>
      </div>
      <AddSound full={sounds.length >= MAX_SOUNDS} />
      <ServerSounds sounds={sounds} />
    </>
  );
}

function AddSound({ full }: { full: boolean }) {
  const [file, setFile] = useState<File>();
  const [url, setUrl] = useState<string>();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState(DEFAULT_EMOJI);
  const [fileError, setFileError] = useState<string>();
  const picker = useRef<HTMLInputElement>(null);
  const { busy, error, run } = useSubmit();
  const urlRef = useRef(url);
  urlRef.current = url;
  const stopRef = useRef<() => void>();
  const revoke = (u?: string) => { stopRef.current?.(); stopRef.current = undefined; if (u) URL.revokeObjectURL(u); }; // stop the preview, then free its file
  useEffect(() => () => revoke(urlRef.current), []);

  const choose = (f: File | undefined) => {
    if (!f) return;
    revoke(url);
    setFile(f);
    setUrl(URL.createObjectURL(f));
    setName(nameFromFile(f.name));
    setFileError(checkSoundFile(f) ?? undefined);
  };
  const reset = () => {
    revoke(url);
    setFile(undefined);
    setUrl(undefined);
    setName("");
    setEmoji(DEFAULT_EMOJI);
    setFileError(undefined);
  };
  const trimmed = name.trim();
  const nameError = file && (trimmed.length === 0 ? "Give it a name" : trimmed.length > 32 ? "At most 32 characters" : undefined);
  const canAdd = !!file && !fileError && !nameError && !full && !busy;

  return (
    <section aria-label="Add a sound" className="grid gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => picker.current?.click()}><Upload aria-hidden />{file ? file.name : "Choose file"}</Button>
        <input ref={picker} type="file" accept="audio/ogg,audio/mpeg,audio/wav,.ogg,.opus,.mp3,.wav" aria-label="Choose a sound file" className="hidden"
          onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
        <Input value={name} aria-label="Sound name" placeholder="Name" className="w-48" aria-invalid={nameError ? true : undefined}
          disabled={!file} onChange={(e) => setName(e.target.value)} />
        <EmojiPicker
          onPick={(v) => { if ("unicode" in v) setEmoji(v.unicode); }}
          trigger={<RefButton variant="outline" size="icon" aria-label="Sound emoji" title="Sound emoji">{emoji}</RefButton>} />
        <Button variant="outline" disabled={!url || !!fileError} onClick={() => { if (!url) return; stopRef.current?.(); stopRef.current = play(url); }}><Play aria-hidden />Preview</Button>
        <Button disabled={!canAdd}
          onClick={() => run(async () => { await client.uploadSound(trimmed, emoji, file!); reset(); })}>Add sound</Button>
      </div>
      {full && <p className="text-xs text-destructive" role="alert">The soundboard is full. Delete a sound to add another.</p>}
      {(fileError ?? nameError) && <p className="text-xs text-destructive" role="alert">{fileError ?? nameError}</p>}
      <ErrorText error={error} />
    </section>
  );
}

function ServerSounds({ sounds }: { sounds: Sound[] }) {
  const members = useApp((s) => s.server?.members);
  const [toDelete, setToDelete] = useState<Sound>();
  useEffect(() => { client.loadMembers().catch(() => undefined); }, []);
  const creator = (s: Sound) => {
    const m = s.creator_id ? members?.[s.creator_id] : undefined;
    return m ? displayName(m.user) : "Someone";
  };
  return (
    <section aria-label="Server sounds" className="grid gap-3">
      {sounds.length === 0 ? <p className="text-muted-foreground">No sounds yet.</p> : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Emoji</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Length</TableHead>
              <TableHead>Added by</TableHead>
              <TableHead><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sounds.map((s) => (
              <TableRow key={s.id}>
                <TableCell><EmojiCell sound={s} /></TableCell>
                <TableCell><RenameField key={s.name} sound={s} /></TableCell>
                <TableCell className="text-muted-foreground">{seconds(s.duration_ms)}</TableCell>
                <TableCell className="text-muted-foreground">{creator(s)}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="icon-sm" aria-label={`Play ${s.name}`} title="Play" onClick={() => play(client.url(s.url), s.duration_ms)}><Play aria-hidden /></Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Delete ${s.name}`} title="Delete" onClick={() => setToDelete(s)}><Trash2 aria-hidden /></Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {toDelete && <DeleteDialog sound={toDelete} onClose={() => setToDelete(undefined)} />}
    </section>
  );
}

function EmojiCell({ sound }: { sound: Sound }) {
  const { error, run } = useSubmit();
  return (
    <div className="grid gap-1">
      <EmojiPicker
        onPick={(v) => { if ("unicode" in v && v.unicode !== sound.emoji) void run(async () => { await client.updateSound(sound.id, { emoji: v.unicode }); }); }}
        trigger={<RefButton variant="ghost" size="icon-sm" aria-label={`Change emoji for ${sound.name}`} title="Change emoji">{sound.emoji}</RefButton>} />
      <ErrorText error={error} />
    </div>
  );
}

/** The name cell: edits in place and saves on blur or Enter. */
function RenameField({ sound }: { sound: Sound }) {
  const [name, setName] = useState(sound.name);
  const { error, run } = useSubmit();
  const save = () => {
    const next = name.trim();
    if (next === sound.name) { setName(sound.name); return; }
    void run(async () => { await client.updateSound(sound.id, { name: next }); });
  };
  return (
    <div className="grid gap-1">
      <Input value={name} aria-label={`Rename ${sound.name}`} aria-invalid={error ? true : undefined} className="h-8 w-48 px-2 text-title md:text-sm"
        onChange={(e) => setName(e.target.value)} onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
      <ErrorText error={error} />
    </div>
  );
}

function DeleteDialog({ sound, onClose }: { sound: Sound; onClose: () => void }) {
  const { busy, error, run } = useSubmit();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Delete ${sound.name}?`}</DialogTitle>
          <DialogDescription>People in calls will no longer be able to play it.</DialogDescription>
        </DialogHeader>
        <ErrorText error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={() => run(async () => { await client.deleteSound(sound.id); onClose(); })}>Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}