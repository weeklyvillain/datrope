import { Track, createLocalAudioTrack, type LocalAudioTrack, type Room } from "livekit-client";
import { audioPrefs, captureOptions, chainOptions, type AudioPrefs } from "./audio-prefs";
import { MicProcessor } from "./mic-processor";
import { canPickOutput } from "./output";
import { watchPtt } from "./ptt";

/** Applies this device's audio settings to one call: the mic processor, push to talk, and device or setting changes. */
export class CallAudio {
  readonly processor = new MicProcessor(chainOptions(audioPrefs.getState()));
  private stops: (() => void)[] = [];
  private queue: Promise<void> = Promise.resolve(); // mic changes, one at a time

  constructor(private room: Room, private onError: (message: string) => void) {
    this.stops.push(audioPrefs.subscribe((p, old) => void this.changed(p, old)));
    this.stops.push(watchPtt(window, () => audioPrefs.getState().pttKey.code, (down) => this.processor.setPtt(down)));
  }

  private mic(): LocalAudioTrack | undefined {
    return this.room.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack as LocalAudioTrack | undefined;
  }

  /** Turns the mic on or off. Calls run one after another, so the mic is started once. */
  setMic(on: boolean): Promise<void> {
    const run = this.queue.then(() => this.applyMic(on));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * The first time, the track is published muted and only unmuted once it runs through the processor, so nothing
   * ungated is sent. If the processor fails, voice activity sends the raw mic; push to talk keeps it muted, since a
   * raw mic would be always open.
   */
  private async applyMic(on: boolean) {
    const lp = this.room.localParticipant;
    if (!on) return void (await lp.setMicrophoneEnabled(false));
    let track = this.mic();
    if (!track) {
      track = await createLocalAudioTrack(this.room.options.audioCaptureDefaults);
      await track.mute();
      await lp.publishTrack(track, { source: Track.Source.Microphone });
    }
    if (track.getProcessor() !== this.processor) {
      try {
        await track.setProcessor(this.processor);
      } catch {
        await track.stopProcessor().catch(() => undefined);
        if (audioPrefs.getState().mode === "ptt") {
          this.onError("Push to talk couldn't start, so your microphone stays muted.");
          return;
        }
      }
    }
    await lp.setMicrophoneEnabled(true);
  }

  private async changed(p: AudioPrefs, old: AudioPrefs) {
    this.room.options.audioCaptureDefaults = captureOptions(p); // for the next time the mic starts
    this.processor.setOptions(chainOptions(p));
    if (p.outputDeviceId !== old.outputDeviceId && canPickOutput()) {
      await this.room.switchActiveDevice("audiooutput", p.outputDeviceId).catch(() => undefined);
    }
    if (p.inputDeviceId !== old.inputDeviceId) await this.switchInput(p.inputDeviceId);
    else if ((p.noise === "standard") !== (old.noise === "standard")) {
      // The browser's noise suppression is fixed when capture starts.
      await this.mic()?.restartTrack(captureOptions(p)).catch(() => undefined);
    }
  }

  private async switchInput(id: string) {
    try {
      await this.room.switchActiveDevice("audioinput", id, false); // not exact: Firefox and Safari have no "default" ID
    } catch {
      if (id === "default") return;
      this.onError("Couldn't use that microphone, so the default one is used.");
      await this.room.switchActiveDevice("audioinput", "default", false).catch(() => undefined);
    }
  }

  stop() {
    for (const stop of this.stops) stop();
    this.stops = [];
    void this.processor.destroy(); // also when leaving before LiveKit finished attaching it
  }
}
