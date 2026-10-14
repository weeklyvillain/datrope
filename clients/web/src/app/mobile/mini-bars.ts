type CallState = { channelId?: string | null; status: "idle" | "connecting" | "connected" | "reconnecting" };

/** Which phone mini bars show: none, one, both stacked (tab roots), or both sharing one row (pushed screens).
 *  The voice bar hides on the call's own screen, which has the full controls. */
export function miniBarLayout({ voice, music, compact, pathname }: {
  voice: CallState; music: boolean; compact: boolean; pathname: string;
}): "none" | "voice" | "music" | "stack" | "row" {
  const inCall = voice.status !== "idle" && !!voice.channelId && pathname !== `/channels/${voice.channelId}`;
  if (inCall && music) return compact ? "row" : "stack";
  return inCall ? "voice" : music ? "music" : "none";
}
