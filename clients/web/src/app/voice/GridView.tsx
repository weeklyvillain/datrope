import type { ReactNode } from "react";
import type { VideoTile } from "../../voice/voice";
import { InviteTile } from "./InviteTile";
import { Tile } from "./Tile";

/** One tile in the call: a person's camera or avatar, or a screen share. */
export interface Entry {
  userId: string;
  tile?: VideoTile;
}

export const entryKey = (e: Entry) => e.tile?.id ?? e.userId;

/** Every participant and screen share in a responsive grid, plus the invite tile in a small call. */
export function GridView({ entries, speaking, watching, chip, inviteTo, compact }: {
  entries: Entry[];
  speaking: string[];
  watching: string[];
  chip?: (e: Entry) => ReactNode;
  inviteTo?: string; // channel name; set when the invite tile may show
  compact?: boolean;
}) {
  return (
    <div className={compact ? "grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2" : "grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3"}>
      {entries.map((e) => (
        <Tile key={entryKey(e)} userId={e.userId} tile={e.tile} size="grid" speaking={speaking.includes(e.userId)}
          watching={watching.includes(e.userId)} chip={chip?.(e)} />
      ))}
      {inviteTo !== undefined && <InviteTile channelName={inviteTo} />}
    </div>
  );
}
