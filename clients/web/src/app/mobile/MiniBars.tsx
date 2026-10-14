import { Music, Pause, PhoneOff, Play, X } from "lucide-react";
import { useEffect, useId } from "react";
import { useLocation } from "react-router-dom";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { createStore } from "zustand/vanilla";
import { Button } from "@/components/ui/button";
import { useLayerNavigate } from "@/hooks/use-history-layer";
import { cn } from "@/lib/utils";
import { dmName, useApp } from "../../session";
import { useVoice, voice } from "../../voice/voice";
import { player, usePlayer } from "../player/player-store";
import { MuteControl } from "../voice/VoicePanel";
import { HoldToTalk } from "./HoldToTalk";
import { miniBarLayout } from "./mini-bars";
import { openPlayerScreen } from "./PlayerScreen";

const STATUS = { connecting: "Connecting…", reconnecting: "Reconnecting…" } as const;
const voiceTint = "bg-[color-mix(in_srgb,var(--online)_18%,transparent)]";
const bar = "flex min-h-[56px] items-center gap-1 rounded-xl px-2";
const body = "flex min-w-0 flex-1 items-center gap-2.5 rounded-lg py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring";
const mute = "size-[44px] rounded-full border-0";

// Composers on phones host the bars right above them; the newest one (a thread over its channel) wins.
const hosts = createStore<{ ids: string[] }>(() => ({ ids: [] }));

/** Mounted in a phone composer: the mini bars show here, above it, instead of at the bottom of the screen. */
export function MiniBarsAboveComposer() {
  const id = useId();
  useEffect(() => {
    hosts.setState((s) => ({ ids: [...s.ids, id] }));
    return () => hosts.setState((s) => ({ ids: s.ids.filter((x) => x !== id) }));
  }, [id]);
  const top = useStore(hosts, (s) => s.ids[s.ids.length - 1] === id);
  return top ? <MiniBars compact aboveComposer /> : null;
}

/** The voice and music mini bars on phones: above the tab bar on tab roots, above the composer (or at the bottom) on pushed
 *  screens. Both active on a pushed screen: one shared row. */
export function MiniBars({ compact = false, aboveComposer = false }: { compact?: boolean; aboveComposer?: boolean }) {
  const { pathname } = useLocation();
  const call = useVoice(useShallow((v) => ({ channelId: v.channelId, status: v.status })));
  const music = usePlayer((s) => s.queue.index >= 0);
  const hosted = useStore(hosts, (s) => s.ids.length > 0);
  const layout = miniBarLayout({ voice: call, music, compact, pathname });
  if (layout === "none" || (hosted && !aboveComposer)) return null;
  return (
    <div className={cn("mx-2 grid flex-none gap-1.5",
      compact && !aboveComposer ? "mb-[calc(0.375rem+env(safe-area-inset-bottom,0px))]" : "mb-1.5")}>
      {layout === "row" ? (
        <div className={cn(bar, "gap-0 overflow-hidden bg-card p-0")}>
          <VoicePart compact />
          <MusicPart compact />
        </div>
      ) : (
        <>
          {(layout === "voice" || layout === "stack") && <div className={bar + " " + voiceTint}><VoicePart /></div>}
          {(layout === "music" || layout === "stack") && <div className={cn(bar, "bg-card")}><MusicPart /></div>}
        </>
      )}
    </div>
  );
}

/** The call: channel, status and who's in it; mute, hold to talk, disconnect. Tapping it opens the call screen. */
function VoicePart({ compact = false }: { compact?: boolean }) {
  const v = useVoice(useShallow((x) => ({ channelId: x.channelId, status: x.status })));
  const ch = useApp((s) => (v.channelId ? s.channels[v.channelId] : undefined));
  const me = useApp((s) => s.me?.id);
  const count = useApp((s) => Object.values(s.voice).filter((p) => p.channel_id === v.channelId).length);
  const navigate = useLayerNavigate();
  const name = !ch ? "Voice" : ch.type === "dm" ? dmName(ch, me) : ch.name;
  const href = !ch ? "/" : ch.type === "dm" ? `/messages/${ch.id}` : `/channels/${ch.id}`;
  const status = v.status === "connected" ? `Voice connected · ${count}` : v.status === "idle" ? "" : STATUS[v.status];
  return (
    <section aria-label="Voice call" className={cn("flex min-w-0 items-center gap-1", compact ? cn("min-h-[56px] flex-1 px-2", voiceTint) : "flex-1")}>
      <button type="button" aria-label={`Open call: ${name}`} className={body} onClick={() => navigate(href)}>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{name}</span>
          {!compact && <span className="block truncate text-xs text-online">{status}</span>}
        </span>
      </button>
      <MuteControl variant="default" className={mute} />
      {!compact && <HoldToTalk small />}
      <Button variant="destructive" size="icon" aria-label="Disconnect" className="size-[44px] flex-none rounded-full"
        onClick={() => voice.leave()}><PhoneOff /></Button>
    </section>
  );
}

/** The playing track: cover, title, play/pause and close. Tapping it opens the full-screen player. */
function MusicPart({ compact = false }: { compact?: boolean }) {
  const current = usePlayer((s) => s.queue.tracks[s.queue.index]);
  const playing = usePlayer((s) => s.playing);
  const notice = usePlayer((s) => s.notice);
  if (!current) return null;
  return (
    <section aria-label="Music player" className={cn("flex min-w-0 flex-1 items-center gap-1", compact && "min-h-[56px] px-2")}>
      <button type="button" aria-label={`Open player: ${current.title}`} className={body} onClick={openPlayerScreen}>
        {!compact && <Cover src={current.cover} />}
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{current.title}</span>
          {!compact && (
            <span className="block truncate text-xs text-muted-foreground">
              {notice ?? (playing ? "Playing" : "Paused")}
            </span>
          )}
        </span>
      </button>
      <PlayButton playing={playing} />
      {!compact && (
        <Button variant="ghost" size="icon" aria-label="Close player" className="size-[44px] flex-none rounded-full" onClick={() => player.clear()}>
          <X />
        </Button>
      )}
    </section>
  );
}

function PlayButton({ playing }: { playing: boolean }) {
  return (
    <Button variant="ghost" size="icon" aria-label={playing ? "Pause" : "Play"} className="size-[44px] flex-none rounded-full" onClick={() => player.toggle()}>
      {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
    </Button>
  );
}

function Cover({ src }: { src?: string }) {
  return (
    <span className="grid size-10 flex-none place-items-center overflow-hidden rounded-md bg-secondary text-foreground" aria-hidden>
      {src ? <img src={src} alt="" className="size-full object-cover" /> : <Music className="size-5" />}
    </span>
  );
}
