/** Whether my client should ask to be moved to AFK: in a call, idle for the server's timeout, not there yet. */
export function shouldGoAFK(s: {
  now: number; lastActive: number; timeoutS: number; channelId?: string; afkChannelId?: string; status: string; tried: boolean;
}): boolean {
  if (s.tried || s.status !== "connected" || !s.afkChannelId || !s.channelId || s.channelId === s.afkChannelId) return false;
  return s.now - s.lastActive >= s.timeoutS * 1000;
}

export const isAFKChannel = (serverAfkId: string | undefined, channelId: string | undefined) =>
  !!serverAfkId && serverAfkId === channelId;

/** The server's AFK channel ID, or undefined when none is set or the channel is gone (deleting it sends no server update). */
export const liveAFKId = (afkId: string | undefined, channels: Record<string, unknown>): string | undefined =>
  afkId && channels[afkId] ? afkId : undefined;

/** Whether I count as active in a call: speaking (only while not deafened), or sharing my camera or screen. */
export const isActive = (s: { deafened: boolean; speaking: boolean; camera: boolean; screen: boolean }): boolean =>
  s.camera || s.screen || (s.speaking && !s.deafened);
