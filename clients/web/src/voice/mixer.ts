import { Track, type RemoteTrackPublication, type Room } from "livekit-client";
import { voicePrefs } from "./prefs";

// LiveKit only re-applies a participant's volume to a rebuilt Web Audio gain node when the volume is truthy
// (RemoteAudioTrack.attach/connectWebAudio check `if (this.elementVolume)`), and it rebuilds them whenever
// room.startAudio() runs — e.g. when my microphone starts. A gain of exactly 0 would then snap back to 1,
// so "silent" is -120 dB instead.
const SILENT = 1e-6;

const gain = (pct: number, off: boolean) => (off || pct <= 0 ? SILENT : pct / 100);

/**
 * Also asks the server to stop sending audio I silenced, so nothing leaks while LiveKit rebuilds a gain node.
 * Only when it changes (each call is a signal message) and only for wanted tracks (LiveKit refuses otherwise).
 */
function enable(pub: RemoteTrackPublication | undefined, on: boolean) {
  if (pub && pub.isDesired && pub.isEnabled !== on) pub.setEnabled(on);
}

/** Applies this device's voice settings (volume, mute for me, hide video) and deafen to everyone in the room. */
export function applyPrefs(room: Room, deafened: boolean): void {
  const prefs = voicePrefs.getState();
  for (const p of room.remoteParticipants.values()) {
    const id = p.identity;
    const micOff = deafened || !!prefs.mutedForMe[id];
    p.setVolume(gain(prefs.volume[id] ?? 100, micOff), Track.Source.Microphone);
    p.setVolume(gain(prefs.screenVolume[id] ?? 100, deafened), Track.Source.ScreenShareAudio);
    enable(p.getTrackPublication(Track.Source.Microphone), !micOff);
    enable(p.getTrackPublication(Track.Source.ScreenShareAudio), !deafened);
    const camera = p.getTrackPublication(Track.Source.Camera);
    const want = !prefs.hideVideo[id];
    if (camera && camera.isDesired !== want) camera.setSubscribed(want);
  }
}

/** Re-applies the settings whenever they change; returns the unsubscribe function. */
export function watchPrefs(getRoom: () => Room | undefined, getDeafened: () => boolean): () => void {
  return voicePrefs.subscribe(() => {
    const room = getRoom();
    if (room) applyPrefs(room, getDeafened());
  });
}
