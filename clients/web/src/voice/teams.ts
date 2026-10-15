import type { Schemas } from "@datrope/core";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

export type TeamsDraw = Schemas["TeamsDraw"];

/** The settings of my last draw in a call, to reopen the dialog with. */
export interface TeamSettings {
  channelId: string;
  teams: number;
  perTeam: number;
  userIds: string[];
}

/** The last team draw in my call (VOICE_TEAMS), and the settings of my own last draw. */
export const teamsStore = createStore<{ draw?: TeamsDraw; settings?: TeamSettings }>(() => ({}));

export const useTeams = (channelId: string) => useStore(teamsStore, (s) => (s.draw?.channel_id === channelId ? s.draw : undefined));

export const teamOf = (draw: Pick<TeamsDraw, "teams"> | undefined, userId: string) =>
  draw?.teams ? draw.teams.findIndex((t) => !!t?.includes(userId)) : -1;

export const teamColor = (i: number) => `var(--team-${(i % 8) + 1})`;

/** Why a setup can't be drawn, or null. */
export function validDraw({ teams, perTeam, picked }: { teams: number; perTeam: number; picked: number }): string | null {
  if (picked < teams) return "Pick at least as many people as teams.";
  if (perTeam > 0 && teams * perTeam > picked) return `Not enough people for ${teams} full teams of ${perTeam}.`;
  return null;
}

/** What Re-roll sends: the shown draw again, same shape and same people, minus anyone who left the call. */
export function rerollBody(draw: TeamsDraw, inCall: string[]) {
  const people = [...(draw.teams ?? []).flatMap((t) => t ?? []), ...(draw.bench ?? [])];
  return { teams: draw.teams?.length ?? 2, per_team: draw.per_team || undefined, user_ids: people.filter((id) => inCall.includes(id)) };
}
