import { unwrap } from "@datrope/core";
import { desktop } from "../desktop";
import { client } from "../session";
import type { NotifyPrefs } from "./prefs";

/** Web Push works here: a browser (not the desktop app) with a service worker and the Push API. */
export function pushSupported(): boolean {
  return desktop === null && "serviceWorker" in navigator && "PushManager" in window;
}

/** iPhone and iPad only allow notifications from an app added to the Home Screen. */
export function needsHomeScreen(): boolean {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  return ios && (navigator as Navigator & { standalone?: boolean }).standalone !== true;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// `serviceWorker.ready` never settles without a registration (dev, failed registration), so ask for it directly.
async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Keeps this browser's push subscription in step with the device's notification settings. */
export async function syncPush(prefs: NotifyPrefs, permission: NotificationPermission | "unsupported"): Promise<void> {
  if (!pushSupported()) return;
  if (!prefs.enabled || permission !== "granted") return disablePush();
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { public_key } = await unwrap(client.api.GET("/api/push/key"));
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(public_key) });
  }
  const json = sub.toJSON();
  await unwrap(client.api.PUT("/api/push/subscription", {
    body: { endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" }, level: prefs.level },
  }));
}

/** Stops pushes to this browser: tells the server, then drops the subscription. */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const sub = await currentSubscription();
  if (!sub) return;
  try {
    await unwrap(client.api.DELETE("/api/push/subscription", { body: { endpoint: sub.endpoint } }));
  } finally {
    await sub.unsubscribe();
  }
}
