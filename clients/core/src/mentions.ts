export type MentionFields = { mentions?: string[] | null; mention_everyone?: boolean; mention_roles?: string[] | null };

/** Whether a message pings me: by name, with @everyone, or through a role I hold. */
export function mentionsMe(m: MentionFields, meId: string, roleIds: readonly string[]): boolean {
  return !!m.mentions?.includes(meId) || !!m.mention_everyone || !!m.mention_roles?.some((r) => roleIds.includes(r));
}
