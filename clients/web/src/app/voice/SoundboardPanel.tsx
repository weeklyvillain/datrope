import { Perm, hasPerm, soundList, type Sound } from "@datrope/core";
import { Plus, Star, Volume2 } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { ErrorText } from "@/components/error-text";
import { RefButton } from "@/components/ref-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { client, dmName, errorText, useApp, usePerms } from "../../session";
import { setSoundboardVolume, toggleFavourite, useVoicePrefs, voicePrefs } from "../../voice/prefs";
import { playClip, preload, recordPlay, stopAllClips, shouldPlay, useRecentPlay, type PlayEvent } from "../../voice/soundboard-audio";
import { useVoice, voice } from "../../voice/voice";
import type { Entry } from "./GridView";

const seconds = (s: Sound) => `${(s.duration_ms / 1000).toFixed(1)} s`;
const soundUrl = (s: Sound) => client.url(s.url);

/** Plays other people's soundboard sounds (mounted once in the app shell) and records who played what for the tile chips. */
export function SoundboardListener() {
  // Clips in flight stop when I deafen or leave the call.
  useEffect(() => {
    const stop = voice.store.subscribe((v, prev) => {
      if ((v.deafened && !prev.deafened) || (prev.channelId && v.channelId !== prev.channelId) || (v.status === "idle" && prev.status !== "idle")) stopAllClips();
    });
    return () => { stop(); stopAllClips(); };
  }, []);
  useEffect(() => client.onEvent((type, data) => {
    if (type !== "SOUNDBOARD_PLAY") return;
    const e = data as PlayEvent;
    const sound = client.store.getState().sounds[e.sound_id];
    if (!sound) return; // deleted since
    recordPlay(e.user_id, sound.id); // even for someone I muted: the chip still shows
    const { channelId, deafened } = voice.store.getState();
    if (shouldPlay(e, { channelId: channelId ?? undefined, deafened }, voicePrefs.getState().mutedForMe)) {
      playClip(soundUrl(sound), voicePrefs.getState().soundboardVolume, sound.duration_ms);
    }
  }), []);
  return null;
}

/** A tile's chip: what this person just played, for 3 s. Not for screen share tiles. */
export function soundChip(e: Entry): ReactNode {
  return e.tile?.source === "screen" ? null : <SoundChip userId={e.userId} />;
}

function SoundChip({ userId }: { userId: string }) {
  const play = useRecentPlay(userId);
  const sound = useApp((s) => (play ? s.sounds[play.soundId] : undefined));
  if (!sound) return null;
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary" role="status">
      <span aria-hidden>{sound.emoji}</span>
      <span className="truncate">{sound.name}</span>
    </span>
  );
}

/**
 * The "Soundboard" button and its panel. It always works on the call I am in; disabled (with a tooltip saying why)
 * when I am not in one, cannot play sounds there, or am server-muted.
 */
export function SoundboardButton({ labelled = false, side = "bottom", className }: {
  labelled?: boolean;
  side?: "top" | "bottom";
  className?: string; // the icon button's
}) {
  const callId = useVoice((v) => (v.status === "idle" ? undefined : v.channelId ?? undefined));
  const perms = usePerms(callId);
  const serverMuted = useApp((s) => !!(s.me && s.voice[s.me.id]?.server_mute));
  const reason = !callId ? "Join a call to use the soundboard"
    : serverMuted ? "You are muted by a moderator"
    : !hasPerm(perms, Perm.UseSoundboard) || !hasPerm(perms, Perm.Speak) ? "You cannot play sounds in this call"
    : "";
  const [open, setOpen] = useState(false);
  const guard = (e: { preventDefault(): void }) => { if (reason) e.preventDefault(); }; // aria-disabled stays focusable, so the tooltip reason is reachable
  useEffect(() => {
    if (reason) setOpen(false); // do not pop open again when it clears
  }, [reason]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("flex", labelled && "w-full")}>
            <PopoverTrigger asChild>
              {labelled ? (
                <RefButton variant="outline" size="sm" className={cn("w-full", reason && "opacity-50")} aria-label="Soundboard" aria-disabled={reason ? true : undefined} onClick={guard}>
                  <Volume2 /> Soundboard
                </RefButton>
              ) : (
                <RefButton variant="ghost" size="icon-sm" aria-label="Soundboard" aria-disabled={reason ? true : undefined} onClick={guard}
                  className={cn(open ? "text-foreground" : "text-muted-foreground", reason && "opacity-50", className)}>
                  <Volume2 />
                </RefButton>
              )}
            </PopoverTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{reason || "Soundboard"}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" side={side} className="w-[22rem] p-3" aria-label="Soundboard">
        {callId && <Panel callId={callId} />}
      </PopoverContent>
    </Popover>
  );
}

function Panel({ callId }: { callId: string }) {
  const sounds = useApp(useShallow(soundList));
  const favourites = useVoicePrefs((p) => p.favourites);
  const volume = useVoicePrefs((p) => p.soundboardVolume);
  const title = useApp((s) => {
    const ch = s.channels[callId];
    return !ch ? "" : ch.type === "dm" ? dmName(ch, s.me?.id) : ch.name;
  });
  const canAdd = hasPerm(usePerms(), Perm.ManageExpressions);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  useEffect(() => preload(sounds.map(soundUrl)), [sounds]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? sounds.filter((s) => s.name.toLowerCase().includes(q)) : sounds;
  }, [sounds, query]);
  const favs = shown.filter((s) => favourites.includes(s.id));
  const rest = shown.filter((s) => !favourites.includes(s.id));

  function play(s: Sound, preview: boolean) {
    if (preview) { // Shift-click: only for me, nothing is sent
      playClip(soundUrl(s), volume, s.duration_ms);
      return;
    }
    setError(undefined);
    client.playSound(s.id).catch((e) => setError(errorText(e)));
  }

  const grid = (list: Sound[]) => (
    <ul className="grid grid-cols-3 gap-2">
      {list.map((s) => {
        const fav = favourites.includes(s.id);
        return (
          <li key={s.id} className="relative">
            <button type="button" aria-label={`Play ${s.name}, ${seconds(s)}`} onClick={(e) => play(s, e.shiftKey)}
              className="grid w-full justify-items-center gap-1 rounded-lg border bg-card px-1.5 py-2.5 text-sm outline-none hover:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/50">
              <span className="text-2xl leading-none" aria-hidden>{s.emoji}</span>
              <span className="w-full truncate text-center font-medium">{s.name}</span>
              <span className="text-xs text-muted-foreground">{seconds(s)}</span>
            </button>
            <button type="button" aria-label={`Favourite ${s.name}`} aria-pressed={fav} onClick={() => toggleFavourite(s.id)}
              className={cn("absolute right-1 top-1 grid size-5 place-items-center rounded text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
                fav && "text-primary hover:text-primary")}>
              <Star className={cn("size-3.5", fav && "fill-current")} />
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="grid gap-3">
      <h3 className="font-semibold">{title} soundboard</h3>
      <Input type="search" placeholder="Search sounds" aria-label="Search sounds" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="grid max-h-72 gap-3 overflow-y-auto">
        {favs.length > 0 && (
          <section className="grid gap-2" aria-label="Favourites">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Favourites</h4>
            {grid(favs)}
          </section>
        )}
        {rest.length > 0 && (
          <section className="grid gap-2" aria-label="All sounds">
            {favs.length > 0 && <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">All sounds</h4>}
            {grid(rest)}
          </section>
        )}
        {shown.length === 0 && (
          <p className="py-4 text-center text-sm text-muted-foreground">{sounds.length === 0 ? "No sounds yet." : "No sounds match."}</p>
        )}
      </div>
      {error && <ErrorText error={error} />}
      {canAdd && (
        <Button variant="outline" size="sm" asChild>
          <Link to="/server-settings/soundboard"><Plus /> Add sound</Link>
        </Button>
      )}
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Volume</span>
          <span className="tabular-nums text-muted-foreground">{volume}%</span>
        </div>
        <input type="range" min={0} max={100} step={5} value={volume} aria-label="Soundboard volume, just for you"
          onChange={(e) => setSoundboardVolume(Number(e.target.value))}
          className={cn(
            "h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary",
            "[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary",
            "[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary",
          )} />
      </div>
      <p className="text-xs text-muted-foreground">Everyone in {title} hears a sound you play. Hold Shift to preview it only for yourself.</p>
    </div>
  );
}