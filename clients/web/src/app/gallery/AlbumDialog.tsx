import type { Album, AlbumVisibility } from "@datrope/core";
import { useId, useRef, useState } from "react";
import { client, displayName, useApp } from "../../session";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { UserAvatar } from "@/components/user-avatar";
import { useSubmit } from "@/hooks/use-submit";
import { X } from "@/components/icons";

/** Create an album, or (with album) change its name, who can see it and its collaborators, or delete it. */
export function AlbumDialog({ album, galleryId, onClose, onSaved, onDeleted }: {
  album?: Album; galleryId?: string; onClose: () => void; onSaved: (a: Album) => void; onDeleted?: () => void;
}) {
  const id = useId();
  const [title, setTitle] = useState(album?.title ?? "");
  const [visibility, setVisibility] = useState<AlbumVisibility>(album?.visibility ?? "gallery");
  const [members, setMembers] = useState<string[]>(album?.member_ids ?? []);
  const [confirming, setConfirming] = useState(false);
  const all = useApp((s) => s.server?.members);
  const me = useApp((s) => s.me?.id);
  const people = Object.values(all ?? {}).map((m) => m.user).filter((u) => u.id !== me && u.id !== album?.owner_id);
  const { busy, error, run } = useSubmit();
  const created = useRef<Album>(); // set once createAlbum succeeds, so a retry updates it instead of making a duplicate

  const save = () => void run(async () => {
    const t = title.trim();
    const existing = album ?? created.current;
    let a = existing
      ? await client.updateAlbum(existing.id, { title: t, visibility })
      : await client.createAlbum(galleryId!, { title: t, visibility });
    created.current = a;
    // diff against the server's current members, so a retry after a partial failure doesn't use a stale list
    const before = new Set((existing && !album ? (await client.album(a.id)).member_ids : album?.member_ids) ?? []);
    for (const m of members) if (!before.has(m)) await client.addAlbumMember(a.id, m);
    for (const m of before) if (!members.includes(m)) await client.removeAlbumMember(a.id, m);
    if (members.length || before.size) a = await client.album(a.id);
    onSaved(a);
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-[460px]">
        <DialogHeader><DialogTitle>{album ? "Album settings" : "New album"}</DialogTitle></DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <Field>
            <FieldLabel htmlFor={`${id}-title`}>Name</FieldLabel>
            <Input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} placeholder="Lofoten trip 2026" required />
          </Field>
          <Field>
            <FieldLabel id={`${id}-vis`}>Who can see it</FieldLabel>
            <RadioGroup aria-labelledby={`${id}-vis`} value={visibility} onValueChange={(v) => setVisibility(v as AlbumVisibility)}>
              <label className="flex items-center gap-2 text-sm"><RadioGroupItem value="private" />Only collaborators</label>
              <label className="flex items-center gap-2 text-sm"><RadioGroupItem value="gallery" />Everyone in this gallery</label>
            </RadioGroup>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-add`}>Collaborators</FieldLabel>
            <p className="m-0 text-xs text-muted-foreground">They can add and remove files.</p>
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Collaborators">
              {members.map((m) => {
                const u = all?.[m]?.user;
                return (
                  <li key={m} className="flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-0.5 text-sm">
                    {u && <UserAvatar user={u} size="xs" />}{u ? displayName(u) : m}
                    <Button variant="ghost" size="icon-xs" aria-label={`Remove ${u ? displayName(u) : m}`}
                      onClick={() => setMembers(members.filter((x) => x !== m))}><X /></Button>
                  </li>
                );
              })}
            </ul>
            <NativeSelect id={`${id}-add`} size="sm" value="" onChange={(e) => e.target.value && setMembers([...members, e.target.value])}>
              <NativeSelectOption value="">Add a collaborator…</NativeSelectOption>
              {people.filter((u) => !members.includes(u.id)).map((u) => <NativeSelectOption key={u.id} value={u.id}>{displayName(u)}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          <ErrorText error={error} />
          <DialogFooter className="sm:justify-between">
            {album && album.role === "owner" ? (
              confirming ? (
                <Button variant="destructive" disabled={busy} onClick={() => void run(async () => { await client.deleteAlbum(album.id); onDeleted?.(); })}>
                  Delete album
                </Button>
              ) : <Button variant="outline" onClick={() => setConfirming(true)}>Delete album</Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={busy || !title.trim()}>{album ? "Save" : "Create"}</Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
