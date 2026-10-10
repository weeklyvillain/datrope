import type { Message } from "@datrope/core";
import dm from "./assets/sounds/dm.mp3";
import join from "./assets/sounds/join.mp3";
import leave from "./assets/sounds/leave.mp3";
import { client } from "./session";
import { routeToOutput } from "./voice/output";

const urls = { join, leave, dm };
export type Sound = keyof typeof urls;

const lastPlayed: Partial<Record<Sound, number>> = {};

/** Plays a UI sound. A burst (several people joining at once) plays it once. */
export function play(sound: Sound) {
  const now = Date.now();
  if (now - (lastPlayed[sound] ?? 0) < 300) return;
  lastPlayed[sound] = now;
  const audio = new Audio(urls[sound]);
  audio.volume = 0.5;
  routeToOutput(audio);
  audio.play().catch(() => {}); // blocked until the user has interacted with the page
}

// Someone else's DM, unless I am looking at that conversation.
client.onEvent((type, data) => {
  if (type !== "MESSAGE_CREATE") return;
  const m = data as Message;
  const s = client.store.getState();
  if ((m.author && m.author.id === s.me?.id) || !s.dmIds.includes(m.channel_id)) return;
  if (document.hasFocus() && location.pathname === `/messages/${m.channel_id}`) return;
  play("dm");
});
