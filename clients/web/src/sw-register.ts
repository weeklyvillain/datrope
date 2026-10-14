import { desktop } from "./desktop";

/** Registers the service worker in a browser production build (not Vite dev, not the desktop app). */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || desktop !== null || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => console.warn("service worker:", err));
  });
}
