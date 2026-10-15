import { Perm, hasPerm } from "@datrope/core";
import { Check, Plus } from "@/components/icons";
import { useEffect, useRef, useState } from "react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { client, errorText, useApp, usePerms } from "../../session";
import { NewPlaylistDialog } from "../voice/PlaylistsTab";

/** The playlists I can change, with a check on those that already hold this file. */
export function AddToPlaylistItems({ attachmentId, onNew }: { attachmentId: string; onNew: () => void }) {
  const playlists = useApp((s) => s.playlists);
  const meId = useApp((s) => s.me?.id);
  const canManage = hasPerm(usePerms(), Perm.ManageExpressions);
  const [holding, setHolding] = useState<Record<string, string>>({}); // playlist id → item id holding this file
  const pending = useRef(new Set<string>()); // playlists with an add or remove in flight
  const [error, setError] = useState<string>();
  const editable = Object.values(playlists ?? {}).filter((p) => canManage || p.created_by === meId).sort((a, b) => a.title.localeCompare(b.title));

  useEffect(() => {
    if (!playlists) void client.loadPlaylists().catch((e) => setError(errorText(e)));
  }, [playlists]);
  // One request per playlist I can change, only while this menu is open: fine at the ≤100 playlists a server keeps.
  useEffect(() => {
    let live = true;
    void Promise.all(editable.map(async (p) => {
      const d = await client.playlist(p.id);
      const it = d.items?.find((i) => i.attachment_id === attachmentId);
      return [p.id, it?.id] as const;
    })).then((pairs) => { if (live) setHolding(Object.fromEntries(pairs.filter(([, i]) => i)) as Record<string, string>); })
      .catch((e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentId, editable.length]);

  const toggle = async (pid: string) => {
    if (pending.current.has(pid)) return; // a double click must not add the file twice
    pending.current.add(pid);
    setError(undefined);
    try {
      await change(pid);
    } catch (e) {
      setError(errorText(e));
    } finally {
      pending.current.delete(pid);
    }
  };
  const change = async (pid: string) => {
    if (holding[pid]) {
      await client.removePlaylistItem(pid, holding[pid]);
      setHolding((h) => Object.fromEntries(Object.entries(h).filter(([k]) => k !== pid)));
    } else {
      await client.addToPlaylist(pid, { attachment_id: attachmentId });
      const d = await client.playlist(pid);
      const it = d.items?.find((i) => i.attachment_id === attachmentId);
      if (it) setHolding((h) => ({ ...h, [pid]: it.id }));
    }
  };

  return (
    <>
      {editable.length === 0 && <DropdownMenuItem disabled>No playlists you can change</DropdownMenuItem>}
      {editable.map((p) => (
        <DropdownMenuItem key={p.id} onSelect={(e) => { e.preventDefault(); void toggle(p.id); }}
          aria-checked={!!holding[p.id]} role="menuitemcheckbox">
          <Check className={holding[p.id] ? "" : "invisible"} />{p.title}
          <span className="ml-auto text-xs text-muted-foreground">{p.count}</span>
        </DropdownMenuItem>
      ))}
      {error && <p role="status" className="m-0 px-2 py-1.5 text-xs text-destructive">{error}</p>}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onNew}><Plus />New playlist…</DropdownMenuItem>
    </>
  );
}

export { NewPlaylistDialog };
