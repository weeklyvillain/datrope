import { ApiError, Perm, hasPerm } from "@datrope/core";
import {
  DisconnectReason, Room, RoomEvent, Track,
  type LocalAudioTrack, type LocalVideoTrack, type Participant, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication,
  type RemoteVideoTrack,
} from "livekit-client";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { client, permsIn } from "../session";
import { play } from "../sounds";
import { audioPrefs, captureOptions } from "./audio-prefs";
import { CallAudio } from "./call-audio";
import { applyPrefs, watchPrefs } from "./mixer";
import { canPickOutput } from "./output";
import { UNKNOWN, watchQuality, type Quality } from "./stats";
import { encoding, type StreamSettings } from "./stream-prefs";

export type VideoSource = "camera" | "screen";

/** A camera or a screen share in the call. */
export interface VideoTile {
  id: string; // `${userId}:${source}`
  userId: string;
  source: VideoSource;
  local: boolean;
  track?: LocalVideoTrack | RemoteVideoTrack; // missing until subscribed (screen shares: until "watch")
}

export interface VoiceView {
  channelId?: string;
  status: "idle" | "connecting" | "connected" | "reconnecting";
  error?: string;
  muted: boolean; // my choice, kept between calls
  deafened: boolean; // my choice, kept between calls
  camera: boolean;
  screen: boolean;
  stream?: StreamSettings; // what my screen share sends now; undefined when not live
  speaking: string[]; // user IDs
  tiles: VideoTile[];
  watching: string[]; // user IDs whose screen share I receive
  audioBlocked: boolean; // the browser wants a click before it plays sound
  quality: Quality; // my connection to the voice server
}

const idle: Omit<VoiceView, "muted" | "deafened"> = {
  channelId: undefined, status: "idle", error: undefined, camera: false, screen: false, stream: undefined,
  speaking: [], tiles: [], watching: [], audioBlocked: false, quality: UNKNOWN,
};

// TrackSource.MICROPHONE from @livekit/protocol (livekit-client does not re-export it).
const MICROPHONE_SOURCE = 2;

const SCREEN: Track.Source[] = [Track.Source.ScreenShare, Track.Source.ScreenShareAudio];

const goodbye: Partial<Record<DisconnectReason, string>> = {
  [DisconnectReason.PARTICIPANT_REMOVED]: "You were disconnected from voice.",
  [DisconnectReason.DUPLICATE_IDENTITY]: "You joined voice somewhere else.",
  [DisconnectReason.ROOM_DELETED]: "The voice channel was closed.",
};

const stopAll = (tracks: MediaStreamTrack[]) => {
  for (const t of tracks) t.stop();
};

/** Connects this browser to one channel's LiveKit room at a time. */
class Voice {
  readonly store = createStore<VoiceView>(() => ({ ...idle, muted: false, deafened: false }));
  private room?: Room;
  private audio = new Set<HTMLMediaElement>(); // remote sound being played
  private mutedBeforeDeafen = false;
  private unwatchPerms?: () => void; // follows SPEAK in the app store while connected
  private unwatchPrefs?: () => void; // re-applies volume, mute for me and hide video while in a call
  private callAudio?: CallAudio; // this device's audio settings applied to the call
  private unwatchQuality?: () => void;
  private streamOps: Promise<unknown> = Promise.resolve(); // screen share operations, one at a time

  constructor() {
    client.onEvent((type, data) => {
      if (type === "VOICE_MOVE" && this.store.getState().status !== "idle") {
        void this.join((data as { channel_id: string }).channel_id); // a moderator moved me
      }
    });
  }

  private set(patch: Partial<VoiceView>) {
    this.store.setState(patch);
  }

  /** Joins a channel's or DM's voice, leaving any other. */
  async join(channelId: string) {
    const prev = this.store.getState();
    if (prev.channelId === channelId && prev.status !== "idle") return;
    this.disconnect();
    // webAudioMix: per-person volume above 100 % needs a gain node (an element's volume stops at 1).
    const prefs = audioPrefs.getState();
    const room = new Room({
      adaptiveStream: true, dynacast: true, webAudioMix: true, publishDefaults: { simulcast: true },
      audioCaptureDefaults: captureOptions(prefs),
      audioOutput: canPickOutput() ? { deviceId: prefs.outputDeviceId } : undefined,
    });
    this.room = room;
    this.callAudio = new CallAudio(room, (error) => {
      if (this.room === room) this.set({ error });
    });
    this.unwatchPrefs = watchPrefs(() => this.room, () => this.store.getState().deafened);
    this.set({ ...idle, channelId, status: "connecting" });
    try {
      const { url, token } = await client.joinVoice(channelId, { self_mute: prev.muted, self_deaf: prev.deafened });
      if (this.room !== room) return; // left or switched meanwhile
      this.listen(room);
      await room.connect(url, token, { autoSubscribe: false });
      if (this.room !== room) return;
      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) this.autoSubscribe(pub, p);
      }
      this.set({ status: "connected", audioBlocked: !room.canPlaybackAudio });
      this.unwatchQuality = watchQuality(room, (quality) => {
        if (this.room === room) this.set({ quality });
      });
      play("join");
      // SPEAK can come back in the app store after LiveKit's grant does: re-check the mic then too.
      const canSpeak = (s: ReturnType<typeof client.store.getState>) => hasPerm(permsIn(s, channelId), Perm.Speak);
      this.unwatchPerms = client.store.subscribe((s, old) => {
        if (canSpeak(s) !== canSpeak(old)) void this.applyMic();
      });
      await this.applyMic();
      if (this.room !== room) return;
      this.refresh();
      const now = this.store.getState();
      if (now.muted !== prev.muted || now.deafened !== prev.deafened) await this.report(); // changed while joining
    } catch (e) {
      if (this.room !== room) return;
      this.disconnect();
      this.set({ error: e instanceof ApiError ? e.message : "Could not connect to voice." });
    }
  }

  /** Leaves voice. Mute and deafen stay as they are for the next call. */
  leave() {
    if (this.store.getState().status !== "idle") play("leave");
    this.disconnect();
  }

  /** Forgets the last error message. */
  dismiss() {
    this.set({ error: undefined });
  }

  private disconnect() {
    const room = this.room;
    this.room = undefined;
    this.unwatchPerms?.();
    this.unwatchPerms = undefined;
    this.unwatchPrefs?.();
    this.unwatchPrefs = undefined;
    this.unwatchQuality?.();
    this.unwatchQuality = undefined;
    this.callAudio?.stop();
    this.callAudio = undefined;
    for (const el of this.audio) el.remove();
    this.audio.clear();
    this.set({ ...idle });
    void room?.disconnect();
  }

  private listen(room: Room) {
    const mine = () => this.room === room;
    const refresh = () => {
      if (mine()) this.refresh();
    };
    room
      .on(RoomEvent.TrackPublished, (pub, p) => {
        if (!mine()) return;
        this.autoSubscribe(pub, p);
        this.refresh();
      })
      .on(RoomEvent.TrackSubscribed, (track) => {
        if (!mine()) return;
        if (track.kind === Track.Kind.Audio) this.play(track);
        applyPrefs(room, this.store.getState().deafened); // after attach: the gain node exists now
        this.refresh();
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        if (!mine()) return;
        this.stop(track);
        this.refresh();
      })
      .on(RoomEvent.TrackUnpublished, refresh)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.LocalTrackPublished, refresh)
      .on(RoomEvent.LocalTrackUnpublished, refresh)
      .on(RoomEvent.ParticipantConnected, () => {
        if (mine()) play("join");
      })
      .on(RoomEvent.ParticipantDisconnected, () => {
        if (!mine()) return;
        play("leave");
        this.refresh();
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        if (mine()) this.set({ speaking: speakers.map((p) => p.identity) });
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (mine()) this.set({ audioBlocked: !room.canPlaybackAudio });
      })
      .on(RoomEvent.ParticipantPermissionsChanged, (_prev, p) => {
        if (mine() && p === room.localParticipant) void this.applyMic();
      })
      .on(RoomEvent.Reconnecting, () => {
        if (mine()) this.set({ status: "reconnecting" });
      })
      .on(RoomEvent.Reconnected, () => {
        if (mine()) this.set({ status: "connected" });
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (!mine()) return; // we left on purpose
        if (this.store.getState().status === "connecting") return; // join() reports the failure
        play("leave");
        this.disconnect();
        this.set({ error: (reason !== undefined && goodbye[reason]) || "The voice connection was lost." });
      });
  }

  /** Microphones and cameras play at once; screen shares only after "watch" (spec section 5.4). */
  private autoSubscribe(pub: RemoteTrackPublication, p: RemoteParticipant) {
    if (!SCREEN.includes(pub.source) || this.store.getState().watching.includes(p.identity)) pub.setSubscribed(true);
    // Right away, so hidden cameras are not received and audio muted for me is not sent (join loop and new tracks).
    if (this.room) applyPrefs(this.room, this.store.getState().deafened);
  }

  private play(track: RemoteTrack) {
    const el = track.attach(); // webAudioMix keeps it muted; deafen and volume go through applyPrefs
    this.audio.add(el);
    document.body.append(el);
  }

  private stop(track: RemoteTrack) {
    for (const el of track.detach()) {
      this.audio.delete(el);
      el.remove();
    }
  }

  /** Rebuilds the video tiles and my camera/screen flags from the room. */
  private refresh() {
    const room = this.room;
    if (!room) return;
    const lp = room.localParticipant;
    const tiles: VideoTile[] = [];
    for (const p of [lp, ...room.remoteParticipants.values()]) {
      const local = p === lp;
      for (const [source, kind] of [["camera", Track.Source.Camera], ["screen", Track.Source.ScreenShare]] as const) {
        const pub = p.getTrackPublication(kind);
        if (!pub || pub.isMuted || (local && !pub.track)) continue;
        tiles.push({ id: `${p.identity}:${source}`, userId: p.identity, source, local, track: pub.videoTrack });
      }
    }
    const screen = lp.isScreenShareEnabled;
    // Cleared here too, so the browser's own "Stop sharing" bar (LiveKit unpublishes on `ended`) resets the menu.
    this.set({ tiles, camera: !!lp.getTrackPublication(Track.Source.Camera)?.track, screen, ...(!screen && { stream: undefined }) });
  }

  async setMuted(muted: boolean) {
    if (this.store.getState().deafened) this.mutedBeforeDeafen = muted; // undeafening keeps this choice
    this.set({ muted, deafened: muted && this.store.getState().deafened }); // unmuting also undeafens
    this.applyAudio();
    await this.applyMic();
    await this.report();
  }

  async setDeafened(deafened: boolean) {
    if (deafened) this.mutedBeforeDeafen = this.store.getState().muted;
    this.set({ deafened, muted: deafened || this.mutedBeforeDeafen }); // deafening also mutes
    this.applyAudio();
    await this.applyMic();
    await this.report();
  }

  private applyAudio() {
    const { deafened } = this.store.getState();
    if (this.room) applyPrefs(this.room, deafened); // with webAudioMix the elements stay muted: gain and setEnabled
  }

  /** Sends my microphone when I may speak, am not server-muted and have not muted myself. */
  private async applyMic() {
    const room = this.room;
    const { channelId, muted, status } = this.store.getState();
    if (!room || !channelId || status === "idle" || status === "connecting") return;
    // LiveKit's grant covers server mute and SPEAK changes; the local check is for the UI state in between.
    const grant = room.localParticipant.permissions;
    const sources = grant?.canPublishSources ?? [];
    const granted = !!grant?.canPublish && (sources.length === 0 || sources.includes(MICROPHONE_SOURCE));
    const allowed = granted && hasPerm(permsIn(client.store.getState(), channelId), Perm.Speak);
    try {
      await this.callAudio?.setMic(allowed && !muted);
    } catch {
      if (this.room !== room) return;
      this.set({ muted: true, error: "Could not use your microphone." });
      await this.report();
    }
  }

  /** Tells the others whether I muted or deafened myself. */
  private async report() {
    const { muted, deafened, status } = this.store.getState();
    if (status === "idle") return; // sent with the next join instead
    await client.setVoiceSelf({ self_mute: muted, self_deaf: deafened }).catch(() => undefined);
  }

  async toggleCamera() {
    const lp = this.room?.localParticipant;
    if (!lp) return;
    const track = lp.getTrackPublication(Track.Source.Camera)?.track;
    const room = this.room;
    try {
      // Unpublish rather than mute, so the server (and so everyone) sees the camera go off.
      if (track) await lp.unpublishTrack(track);
      else await lp.setCameraEnabled(true);
    } catch {
      if (this.room !== room) return;
      this.set({ error: track ? "Could not turn off your camera." : "Could not start your camera." });
    }
    if (this.room === room) this.refresh();
  }

  /**
   * Opens the browser's screen picker; undefined when the picker was closed. Plain MediaStreamTracks rather than
   * LiveKit tracks: a swapped-in source then leaves no unpublished LiveKit wrapper listening to it.
   */
  private async capture(s: StreamSettings) {
    const e = encoding(s);
    try {
      const media = await navigator.mediaDevices.getDisplayMedia({
        audio: s.audio,
        video: { width: { max: e.width }, height: { max: e.height }, frameRate: { ideal: e.fps, max: e.fps } },
      });
      const video = media.getVideoTracks()[0]!;
      video.contentHint = e.contentHint;
      return { video, audio: media.getAudioTracks()[0] };
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotAllowedError") return undefined; // picker closed
      throw err;
    }
  }

  /** Applies settings to the live screen share: capture size and fps, content hint, bitrate and degradation. */
  private async tune(s: StreamSettings) {
    const pub = this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    const track = pub?.videoTrack as LocalVideoTrack | undefined;
    if (!pub || !track) return;
    const e = encoding(s);
    const videoEncoding = { maxBitrate: e.maxBitrate, maxFramerate: e.fps };
    // LiveKit recomputes encodings from these after a source swap and republishes with them after a full reconnect.
    // (Firefox with dynacast still restores the bitrate LiveKit computed at publish when it resumes the layer.)
    pub.options = { ...pub.options, videoEncoding, degradationPreference: e.degradationPreference };
    track.publishOptions = { ...track.publishOptions, videoEncoding, degradationPreference: e.degradationPreference };
    const mst = track.mediaStreamTrack;
    await mst.applyConstraints({ width: { max: e.width }, height: { max: e.height }, frameRate: { ideal: e.fps, max: e.fps } });
    mst.contentHint = e.contentHint;
    const sender = track.sender;
    if (sender) {
      const params = sender.getParameters();
      for (const enc of params.encodings) {
        enc.maxBitrate = e.maxBitrate;
        enc.maxFramerate = e.fps;
        enc.scaleResolutionDownBy = 1; // the capture is already the chosen size
      }
      await sender.setParameters(params);
    }
    await track.setDegradationPreference(e.degradationPreference);
  }

  /** Runs screen share operations one at a time, so each starts from what the last one left. */
  private serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.streamOps.then(op);
    this.streamOps = run.catch(() => undefined);
    return run;
  }

  /** Goes live: the browser's picker chooses the source, `s` the quality. */
  startScreen(s: StreamSettings) {
    return this.serial(async () => {
      const room = this.room;
      const lp = room?.localParticipant;
      if (!room || !lp || lp.isScreenShareEnabled) return;
      let loose: MediaStreamTrack[] = []; // captured but not handed to LiveKit yet: stopped if anything fails
      try {
        const got = await this.capture(s);
        if (!got) return;
        loose = [got.video, ...(got.audio ? [got.audio] : [])];
        if (this.room !== room) return stopAll(loose);
        const e = encoding(s);
        // One full-quality layer: simulcast could leave viewers stuck on a low one. H.264 is hardware-encoded where possible.
        await lp.publishTrack(got.video, {
          source: Track.Source.ScreenShare, videoCodec: "h264", simulcast: false,
          videoEncoding: { maxBitrate: e.maxBitrate, maxFramerate: e.fps }, degradationPreference: e.degradationPreference,
        });
        loose = loose.filter((t) => t !== got.video);
        if (got.audio) await lp.publishTrack(got.audio, { source: Track.Source.ScreenShareAudio });
        loose = [];
        await this.tune(s);
        if (this.room === room) this.set({ stream: { ...s, audio: !!got.audio } });
      } catch {
        stopAll(loose);
        // Half live (video out, audio or tuning failed) would leave a share with no settings menu: take it down.
        if (lp.isScreenShareEnabled) await lp.setScreenShareEnabled(false).catch(() => undefined);
        if (this.room === room) this.set({ error: "Could not share your screen." });
      }
      if (this.room === room) this.refresh();
    });
  }

  /** Shares something else without stopping: the publications stay, so viewers keep watching. */
  changeSource() {
    return this.serial(() => this.swapSource(this.store.getState().stream));
  }

  private async swapSource(s: StreamSettings | undefined) {
    const room = this.room;
    const lp = room?.localParticipant;
    const video = lp?.getTrackPublication(Track.Source.ScreenShare)?.videoTrack as LocalVideoTrack | undefined;
    if (!room || !lp || !s || !video) return;
    const oldVideo = video.mediaStreamTrack;
    let swapped = false;
    let loose: MediaStreamTrack[] = [];
    try {
      const got = await this.capture(s);
      if (!got) return; // picker closed: keep sharing what I was
      loose = [got.video, ...(got.audio ? [got.audio] : [])];
      if (this.room !== room || lp.getTrackPublication(Track.Source.ScreenShare)?.track !== video) return stopAll(loose);
      await video.replaceTrack(got.video);
      swapped = true;
      const oldAudio = lp.getTrackPublication(Track.Source.ScreenShareAudio)?.audioTrack as LocalAudioTrack | undefined;
      if (got.audio && oldAudio) {
        const m = oldAudio.mediaStreamTrack;
        await oldAudio.replaceTrack(got.audio);
        m.stop();
      } else if (got.audio) {
        await lp.publishTrack(got.audio, { source: Track.Source.ScreenShareAudio });
      } else if (oldAudio) {
        await lp.unpublishTrack(oldAudio);
      }
      oldVideo.stop(); // only now: until here a failure can still swap the old source back
      loose = [];
      await this.tune(s); // replaceTrack recomputed encodings from the publish options; put mine back
      if (this.room === room && lp.isScreenShareEnabled) this.set({ stream: { ...s, audio: !!got.audio } });
    } catch {
      // Keep sharing what I was: put the old video back and let the new capture go.
      if (swapped && oldVideo.readyState === "live") await video.replaceTrack(oldVideo).then(() => this.tune(s)).catch(() => undefined);
      stopAll(loose.filter((t) => t !== video.mediaStreamTrack));
      if (this.room === room) {
        if (lp.isScreenShareEnabled) this.set({ stream: { ...s, audio: !!lp.getTrackPublication(Track.Source.ScreenShareAudio) } });
        this.set({ error: "Could not change what you share." });
      }
    }
    if (this.room === room) this.refresh();
  }

  /** Changes quality while live, on top of the current settings. Turning audio on needs a new capture, so it asks for the source again. */
  applyStream(patch: Partial<StreamSettings>) {
    return this.serial(async () => {
      const room = this.room;
      const lp = room?.localParticipant;
      const prev = this.store.getState().stream;
      if (!room || !lp || !prev) return;
      const next = { ...prev, ...patch };
      if (next.audio && !prev.audio) return this.swapSource(next);
      try {
        if (!next.audio && prev.audio) {
          const audio = lp.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
          if (audio) await lp.unpublishTrack(audio);
        }
        await this.tune(next);
        if (this.room === room && lp.isScreenShareEnabled) this.set({ stream: next });
      } catch {
        if (this.room !== room) return;
        await this.tune(prev).catch(() => undefined);
        const audio = !!lp.getTrackPublication(Track.Source.ScreenShareAudio);
        if (lp.isScreenShareEnabled) this.set({ stream: { ...prev, audio } });
        this.set({ error: "Could not apply stream settings." });
      }
    });
  }

  /** Stops sharing (screen and its audio). */
  stopScreen() {
    return this.serial(async () => {
      const room = this.room;
      const lp = room?.localParticipant;
      if (!lp) return;
      try {
        await lp.setScreenShareEnabled(false);
      } catch {
        if (this.room === room) this.set({ error: "Could not stop sharing." });
      }
      if (this.room === room) this.refresh();
    });
  }

  /** Starts or stops receiving someone's screen share. */
  watch(userId: string, on: boolean) {
    const p = this.room?.remoteParticipants.get(userId);
    for (const source of SCREEN) p?.getTrackPublication(source)?.setSubscribed(on);
    const others = this.store.getState().watching.filter((x) => x !== userId);
    this.set({ watching: on ? [...others, userId] : others });
    this.refresh();
  }

  /** My mic's level and gate state while in a call, for the settings meter. */
  micMeter() {
    const p = this.callAudio?.processor;
    const m = p?.meter();
    return m && p ? { ...m, enhancedFailed: p.enhancedFailed } : undefined;
  }

  /** Plays call audio after the browser blocked autoplay; call it from a click. */
  startAudio() {
    const room = this.room;
    void room?.startAudio().then(() => {
      if (this.room === room) this.set({ audioBlocked: false });
    });
  }
}

export const voice = new Voice();

/** Subscribes a component to part of the voice connection's state. */
export function useVoice<T>(selector: (v: VoiceView) => T): T {
  return useStore(voice.store, selector);
}
