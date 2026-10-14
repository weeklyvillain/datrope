import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { notifyPrefs } from "../notify/prefs";
import { pushSupported, syncPush } from "../notify/push";

const permission = () => ("Notification" in window ? Notification.permission : "unsupported" as const);

/** Keeps Web Push in step with this device's notification settings and follows notification taps. Renders nothing. */
export function PushBridge() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!pushSupported()) return;
    const sync = () => void syncPush(notifyPrefs.getState(), permission()).catch((err) => console.warn("push:", err));
    sync(); // the endpoint may have rotated, or the server pruned it
    return notifyPrefs.subscribe(sync);
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "navigate" && typeof e.data.url === "string" && e.data.url.startsWith("/") && !e.data.url.startsWith("//")) navigate(e.data.url);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [navigate]);

  return null;
}
