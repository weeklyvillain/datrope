export const AVATAR_COLORS = 8;

/** 1–8, from an FNV-1a hash of the user ID (snowflake low bits cluster, so not id % 8). */
export function avatarColorIndex(userId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % AVATAR_COLORS) + 1;
}

/** The initials background for someone without an avatar. */
export const avatarColor = (userId: string) => `var(--avatar-${avatarColorIndex(userId)})`;
