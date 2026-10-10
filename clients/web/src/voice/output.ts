import { audioPrefs } from "./audio-prefs";

/** Whether call audio can go to a chosen speaker: it plays through Web Audio, whose setSinkId Firefox lacks. */
export const canPickOutput = () => typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;

/** Plays an element (soundboard, UI sounds, mic test) through the chosen output device, when the browser can. */
export function routeToOutput(el: HTMLMediaElement, deviceId = audioPrefs.getState().outputDeviceId) {
  const sink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (deviceId === "default" || !sink.setSinkId) return;
  sink.setSinkId(deviceId).catch(() => undefined); // device gone: keep the default
}
