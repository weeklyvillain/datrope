import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

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
}

/** What the chrome and the drawer show until the shell answers. */
export const emptyRailState: RailState = {
  servers: [], selected: null, updateReady: false, mode: "closed", maximized: false, platform: "windows",
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
