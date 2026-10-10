import {
  ApiError, DatropeClient, compareIds, myBasePerms, myChannelPerms, myRoleIds, unwrap,
  type Channel, type InstanceInfo, type PresenceStatus, type PublicUser, type ServerState, type State,
} from "@datrope/core";
import { useStore } from "zustand";
import { useEffect, useState } from "react";
import { myRank, outranks } from "@/lib/hierarchy";

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

// The store is reset before onSignedOut runs, so remember whether I was a guest.
let wasGuest = false;

export const client = new DatropeClient({
  baseUrl: "",
  wsUrl,
  onSignedOut: () => window.location.assign(wasGuest ? "/guest-ended" : "/login"),
});

client.store.subscribe((s) => {
  if (s.me) wasGuest = !!s.me.guest_expires_at;
});

/** Subscribes a component to part of the app state. Select existing objects or primitives. */
export function useApp<T>(selector: (s: State) => T): T {
  return useStore(client.store, selector);
}

/** My server-level permissions, or my permissions in a channel or DM. */
export function usePerms(channelId?: string): number {
  return useApp((s) => (channelId ? myChannelPerms(s, channelId) : myBasePerms(s)));
}

/** My place in the role hierarchy: my highest role's position, Infinity for the owner. */
export function useMyRank(): number {
  return useApp((s) => (s.server && s.me ? myRank(s.server.server, Object.values(s.server.roles), s.me.id, myRoleIds(s)) : 0));
}

/** Whether I may moderate the user: I outrank them (non-members rank below everyone, nobody outranks the owner). */
export function outranksUser(s: State, userId: string): boolean {
  if (!s.server || !s.me) return false;
  const roles = Object.values(s.server.roles);
  const target = s.server.members[userId];
  const theirs = target ? myRank(s.server.server, roles, userId, target.role_ids ?? []) : -1;
  return outranks(myRank(s.server.server, roles, s.me.id, myRoleIds(s)), theirs);
}

/** My permissions in a channel or DM, read from the current state (for code outside React). */
export function permsIn(s: State, channelId: string): number {
  return myChannelPerms(s, channelId);
}

const PRESENCE_KEY = "datrope.presence";

export function savedPresence(): PresenceStatus {
  try {
    const v = localStorage.getItem(PRESENCE_KEY);
    return v === "idle" || v === "invisible" ? v : "online";
  } catch {
    return "online";
  }
}

export function choosePresence(p: PresenceStatus) {
  try {
    localStorage.setItem(PRESENCE_KEY, p);
  } catch {
    // Storage unavailable (private window): the choice lasts for this session only.
  }
  client.setPresence(p);
}

export function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

/** The colour of the user's highest coloured role in the server, if any. */
export function roleColor(sv: ServerState | null | undefined, userId: string): string | undefined {
  const ids = sv?.members[userId]?.role_ids ?? [];
  return Object.values(sv?.roles ?? {}).filter((r) => r.color && ids.includes(r.id)).sort((a, b) => b.position - a.position)[0]?.color;
}

export const displayName = (u: Pick<PublicUser, "display_name" | "username">) => u.display_name || u.username;

/** Finds a user's name anywhere in the state. */
export function userName(s: State, userId: string): string {
  const m = s.server?.members[userId];
  if (m) return displayName(m.user);
  for (const id of s.dmIds) {
    const p = s.channels[id]?.participants?.find((x) => x.id === userId);
    if (p) return displayName(p);
  }
  return "Someone";
}

export function dmName(ch: Channel | undefined, meId: string | undefined): string {
  const others = ch?.participants?.filter((p) => p.id !== meId) ?? [];
  return others.map(displayName).join(", ") || "Just you";
}

/** Ends this device's session and returns to the sign-in page. */
export async function signOut() {
  await unwrap(client.api.POST("/api/auth/logout"));
  client.disconnect();
  window.location.assign("/login");
}

type Tab = "channel" | "text" | "dm"; // "text": the last channel visited that is not a voice channel
const lastKey = (tab: Tab) => `datrope.last-${tab}`;

/** The last channel or DM visited in this tab (per browser tab, via sessionStorage). */
export function lastVisited(tab: Tab): string | undefined {
  try {
    return sessionStorage.getItem(lastKey(tab)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberVisit(tab: Tab, id: string) {
  try {
    sessionStorage.setItem(lastKey(tab), id);
  } catch {
    // Storage unavailable: switching tabs falls back to the first channel / the DM list.
  }
}

export function isUnread(rs?: { lastReadId?: string; lastMessageId?: string }): boolean {
  return !!rs?.lastMessageId && (!rs.lastReadId || compareIds(rs.lastMessageId, rs.lastReadId) > 0);
}

export const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

export function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Firefox\//.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${browser} (web)`;
}

/** Only allow same-site relative redirects after sign-in. */
export function safeNext(next: string | null): string {
  return next && /^\/(?![/\\])/.test(next) && !/[\\\t\r\n]/.test(next) ? next : "/";
}

let instance: Promise<InstanceInfo> | undefined;

/** Server settings the UI needs (e.g. the upload limit), fetched once per page load. */
export function instanceInfo(): Promise<InstanceInfo> {
  instance ??= unwrap(client.api.GET("/api/instance")).catch((e: unknown) => {
    instance = undefined; // retry next time
    throw e;
  });
  return instance;
}

/** Drops the cached instance info, after an admin changes what it reports. */
export function forgetInstanceInfo() {
  instance = undefined;
}

/** Instance info for rendering: undefined until it loads (or if it fails). */
export function useInstanceInfo(): InstanceInfo | undefined {
  const [info, setInfo] = useState<InstanceInfo>();
  useEffect(() => {
    let live = true;
    instanceInfo().then((i) => { if (live) setInfo(i); }, () => undefined);
    return () => { live = false; };
  }, []);
  return info;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
