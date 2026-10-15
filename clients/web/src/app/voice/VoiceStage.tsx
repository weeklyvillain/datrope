import { Perm, canCreateInvites, hasPerm, voiceMembers } from "@datrope/core";
import { Phone } from "@/components/icons";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { client, useApp, usePerms } from "../../session";
import { useVoice, voice, type VideoTile } from "../../voice/voice";
import { CallControls, type LayoutControl } from "./CallControls";
import { GridView, type Entry } from "./GridView";
import { soundChip } from "./SoundboardPanel";
import { MusicTile } from "./MusicTile";
import { StageView, isWatchedScreen } from "./StageView";
import type { TileSize } from "./Tile";
import { WatchTile } from "../watch/WatchTile";

const NO_TILES: VideoTile[] = [];
const NOBODY: string[] = [];

export type VoiceLayout = "grid" | "stage";

/** The call's layout: watching a share or starting a shared video switches to the stage, stopping the last one returns to the grid. */
export function useVoiceLayout(channelId: string) {
  const watching = useVoice((v) => (v.channelId === channelId ? v.watching.length : 0));
  const watchOn = useApp((s) => !!s.watch[channelId]);
  const live = watching + (watchOn ? 1 : 0); // things worth the stage
  // Same check as the stage: a share of someone else that I'm watching, with its tile in the call.
  const canStageShare = useVoice((v) => v.channelId === channelId
    && v.tiles.some((t) => t.source === "screen" && !t.local && v.watching.includes(t.userId)));
  const canStage = canStageShare || watchOn;
  const [layout, setLayout] = useState<VoiceLayout>(live > 0 ? "stage" : "grid");
  const last = useRef({ channelId, live });
  useEffect(() => {
    const was = last.current.channelId === channelId ? last.current.live : 0;
    if (live > was) setLayout("stage");
    else if (live === 0) setLayout("grid");
    last.current = { channelId, live };
  }, [channelId, live]);
  return { layout: canStage ? layout : "grid", setLayout, canStage };
}

type StageProps = {
  channelId: string;
  joinLabel?: string;
  inviteTo?: string; // channel name: offer the invite tile in a small call
  chip?: (e: Entry) => ReactNode;
  compact?: boolean; // bounded height, for a call above a conversation
  onOpenMusic?: () => void; // the music bot's tile opens the music panel
  layoutControl?: LayoutControl; // phones: the grid/stage switch in the call controls' ⋯ menu
};

/**
 * A channel's or DM's call: everyone in it (cameras, avatars, screen shares) in a grid or stage, and the join button.
 * Full size (not `compact`), it fills its parent's height and shows the call controls while I'm in it.
 */
export function VoiceStage({ layout, ...props }: StageProps & { layout?: VoiceLayout }) {
  // Without a layout from the caller (a DM call), it follows watching on its own.
  return layout ? <Call {...props} layout={layout} /> : <OwnLayoutCall {...props} />;
}

function OwnLayoutCall(props: StageProps) {
  return <Call {...props} layout={useVoiceLayout(props.channelId).layout} />;
}

function Call({ channelId, joinLabel = "Join voice", layout, inviteTo, chip = soundChip, compact, onOpenMusic, layoutControl }: StageProps & { layout: VoiceLayout }) {
  const members = useApp(useShallow((s) => voiceMembers(s, channelId).map((v) => v.user_id)));
  const here = useVoice((v) => v.channelId === channelId && v.status !== "idle");
  const tiles = useVoice((v) => (v.channelId === channelId ? v.tiles : NO_TILES));
  const speaking = useVoice((v) => (v.channelId === channelId ? v.speaking : NOBODY));
  const watching = useVoice((v) => (v.channelId === channelId ? v.watching : NOBODY));
  const audioBlocked = useVoice((v) => v.channelId === channelId && v.audioBlocked);
  const perms = usePerms(channelId);
  const canConnect = hasPerm(perms, Perm.ConnectVoice);
  const canInvite = useApp(canCreateInvites);
  const botId = useApp((s) => s.music[channelId]?.bot_id);
  const bot = botId ? (size: TileSize) => (
    <MusicTile channelId={channelId} size={size} speaking={speaking.includes(botId)} onOpen={onOpenMusic} />
  ) : undefined;
  const voiceChannel = useApp((s) => s.channels[channelId]?.type === "voice");
  const watchLoaded = useApp((s) => s.watch[channelId] !== undefined);
  const watchOn = useApp((s) => !!s.watch[channelId]);
  // Updates reach everyone who can see the channel; only the state at page load needs fetching.
  useEffect(() => {
    if (voiceChannel && !watchLoaded) void client.getWatch(channelId).catch(() => undefined);
  }, [voiceChannel, watchLoaded, channelId]);
  const watch = watchOn ? (size: TileSize) => <WatchTile channelId={channelId} size={size} /> : undefined;

  // Each member: their camera tile or an avatar, then their screen share. Tiles of people not (yet) listed come last.
  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    const used = new Set<string>();
    for (const id of members) {
      const camera = tiles.find((t) => t.userId === id && t.source === "camera");
      const screen = tiles.find((t) => t.userId === id && t.source === "screen");
      out.push({ userId: id, tile: camera });
      if (camera) used.add(camera.id);
      if (screen) {
        out.push({ userId: id, tile: screen });
        used.add(screen.id);
      }
    }
    for (const t of tiles) if (!used.has(t.id)) out.push({ userId: t.userId, tile: t });
    return out;
  }, [members, tiles]);

  const stage = layout === "stage" && (watchOn || entries.some((e) => isWatchedScreen(e, watching)));
  const callers = members.length + (botId ? 1 : 0);
  return (
    <div className={compact ? "flex max-h-[45vh] flex-col gap-3 overflow-y-auto p-2" : "flex min-h-0 flex-1 flex-col"}>
      <div className={compact ? "contents" : "flex min-h-0 flex-1 flex-col gap-4 p-4"}>
        {audioBlocked && <Button onClick={() => voice.startAudio()}>Click to hear the call</Button>}
        {(entries.length > 0 || bot || watch) && (
          <div className={compact ? undefined : "min-h-0 flex-1"}>
            {stage ? (
              <StageView entries={entries} speaking={speaking} watching={watching} chip={chip} bot={bot} watch={watch} compact={compact} />
            ) : (
              <GridView entries={entries} speaking={speaking} watching={watching} chip={chip} bot={bot} watch={watch} compact={compact}
                inviteTo={here && inviteTo !== undefined && canInvite && members.length >= 1 && callers <= 4 ? inviteTo : undefined} />
            )}
          </div>
        )}
        {members.length === 0 && !here && <p className="text-muted-foreground">Nobody is here yet.</p>}
        {!here && (
          <div>
            <Button disabled={!canConnect} onClick={() => void voice.join(channelId)}><Phone /> {joinLabel}</Button>
            {!canConnect && <p className="mt-2 text-sm text-muted-foreground">You do not have permission to join.</p>}
          </div>
        )}
      </div>
      {here && !compact && <CallControls layout={layoutControl} />}
    </div>
  );
}
