/** A tap on a touch screen first reveals hidden controls; once they show, it plays or pauses. */
export function videoControlsAfterTap(s: { playing: boolean; shown: boolean }): { shown: boolean; toggle: boolean } {
  if (s.playing && !s.shown) return { shown: true, toggle: false };
  return { shown: true, toggle: true };
}
