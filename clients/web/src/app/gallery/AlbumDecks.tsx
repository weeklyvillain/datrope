import type { Album } from "@datrope/core";
import { Lock, Plus } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BareButton } from "@/components/bare-button";
import { ErrorText } from "@/components/error-text";
import { attachmentImage } from "@/lib/sized-image";
import { cn } from "@/lib/utils";
import { AlbumDialog } from "./AlbumDialog";
import { useGalleryAlbums } from "./albums";

/** Back to front: the third-newest image at the back, tilted left; the newest on top. */
const TILT = [
  "-rotate-[8deg] -translate-x-2.5 group-hover:-rotate-[12deg] group-hover:-translate-x-4",
  "rotate-[6deg] translate-x-2.5 group-hover:rotate-[10deg] group-hover:translate-x-4",
  "",
];

const count = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

/** A gallery's albums as fanned decks of their newest images, then a New album slot. */
export function AlbumDecks({ galleryId }: { galleryId: string }) {
  const { albums, error } = useGalleryAlbums(galleryId);
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();
  return (
    <section aria-label="Albums" className="flex-none">
      <ul className="m-0 flex list-none gap-2 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden px-3 pt-3 pb-1">
        {albums.map((a) => <li key={a.id} className="flex-none"><Deck album={a} galleryId={galleryId} /></li>)}
        <li className="flex-none">
          <BareButton onClick={() => setCreating(true)}
            className="grid h-[132px] w-28 place-items-center rounded-md border border-dashed text-ui text-muted-foreground hover:bg-accent hover:text-foreground">
            <span className="grid justify-items-center gap-1"><Plus className="size-5" aria-hidden />New album</span>
          </BareButton>
        </li>
      </ul>
      <ErrorText error={error} />
      {creating && <AlbumDialog galleryId={galleryId} onClose={() => setCreating(false)}
        onSaved={(a) => nav(`/channels/${galleryId}/albums/${a.id}`)} />}
    </section>
  );
}

function Deck({ album: a, galleryId }: { album: Album; galleryId: string }) {
  const cards = a.deck ?? [];
  const label = `${a.title}, ${count(a.item_count)}${a.visibility === "private" ? ", private" : ""}`;
  return (
    <Link to={`/channels/${galleryId}/albums/${a.id}`} aria-label={label}
      className="group grid w-36 justify-items-center gap-1 rounded-md p-1 no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="relative h-24 w-full" aria-hidden>
        {[2, 1, 0].map((i, layer) => (
          <span key={i} className={cn("absolute inset-x-5 inset-y-1 overflow-hidden rounded-md border-2 border-card bg-muted shadow-md transition-transform duration-200 motion-reduce:transition-none", TILT[layer])}>
            {cards[i] && <img {...attachmentImage(cards[i], 160, { cover: true })} alt="" loading="lazy" className="size-full object-cover" />}
          </span>
        ))}
      </span>
      <span className="max-w-full truncate text-ui font-semibold text-foreground">{a.title}</span>
      <span className="flex items-center gap-1 text-caption text-muted-foreground">
        {a.visibility === "private" && <Lock className="size-3" aria-hidden />}{count(a.item_count)}
      </span>
    </Link>
  );
}
