import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { StreamSettings } from "@/voice/stream-prefs";

export interface RailServer {
  id: string;
  url: string;
  name: string;
  icon?: string | null;
  unread: boolean;
  mentions: number;
  online: boolean;
}

/** How much of the window the chrome takes: the title bar, the bar with the server drawer over the page, or all of it. */
export type ChromeMode = "closed" | "drawer" | "full";

export interface RailState {
  servers: RailServer[];
  selected: string | null;
  updateReady: boolean;
  /** In effect: "full" whenever there are no servers. */
  mode: ChromeMode;
  maximized: boolean;
  platform: "windows" | "macos" | "linux";
  /** The selected server's page draws the title bar, so the shell bar has no height. */
  barHidden: boolean;
  /** The selected server's colour tokens (names without `--`); empty if it sent none. */
  theme: Record<string, string>;
}

/** What the chrome and the drawer show until the shell answers. */
export const emptyRailState: RailState = {
  servers: [], selected: null, updateReady: false, mode: "closed", maximized: false, platform: "windows", barHidden: false, theme: {},
};

export const listServers = () => invoke<RailState>("servers_list");
export const addServer = (address: string) => invoke<RailState>("server_add", { address });
export const removeServer = (id: string) => invoke<void>("server_remove", { id });
export const reorderServers = (ids: string[]) => invoke<void>("servers_reorder", { ids });
/** Whether the drawer may slide (the shell jumps straight to the end otherwise). */
const animate = () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const selectServer = (id: string) => invoke<void>("server_select", { id, animate: animate() });
export const setChromeMode = (mode: ChromeMode) => invoke<void>("chrome_mode", { mode, animate: animate() });

/** What the drawer asks the title bar webview to open (the dialogs need the whole window). */
export type ChromeRequest = "add" | { remove: string };
export const requestChrome = (action: ChromeRequest) => invoke<void>("chrome_request", { action });
export const restartToUpdate = () => invoke<void>("update_restart");

export const minimizeWindow = () => getCurrentWindow().minimize();
export const toggleMaximizeWindow = () => getCurrentWindow().toggleMaximize();
/** Goes through the shell's close request, which hides the window to the tray. */
export const closeWindow = () => getCurrentWindow().close();

/** A screen or window the user can share, as the shell lists it for the picker. */
export interface ScreenSource {
  id: string;
  kind: "screen" | "window";
  name: string;
  /** A data: URL; missing when the source couldn't be drawn. */
  thumbnail: string | null;
}

/** A server page wants to share: what the picker webview shows. */
export interface ScreenPickRequest {
  server: string;
  sources: ScreenSource[];
  /** The stream quality to start from when going live; null when only a source is asked for. */
  settings: StreamSettings | null;
  /** The requesting server's colour tokens. */
  theme: Record<string, string>;
}

/** The open request, for the picker webview once it has loaded; null if it was answered or replaced meanwhile. */
export const fetchScreenPick = () => invoke<ScreenPickRequest | null>("screen_pick_request");

/** The picker's answer: what to share, or null to cancel, and the quality if the request offered it. */
export const answerScreenPick = (id: string | null, settings: StreamSettings | null) =>
  invoke<void>("screen_pick_done", { id, settings });

export const onRailState = (cb: (s: RailState) => void) => listenHere("rail_state", cb);
export const onChromeRequest = (cb: (a: ChromeRequest) => void) => listenHere("chrome_request", cb);

/** Listens to an event the shell sends to this webview; returns the unsubscribe for an effect cleanup. */
function listenHere<T>(event: string, cb: (payload: T) => void): () => void {
  let stop: (() => void) | undefined;
  let stopped = false;
  void getCurrentWebview().listen<T>(event, (e) => cb(e.payload)).then((un) => {
    if (stopped) un();
    else stop = un;
  });
  return () => {
    stopped = true;
    stop?.();
  };
}
