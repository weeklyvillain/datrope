/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

declare const self: ServiceWorkerGlobalScope;

// The build's files. A new worker waits until every window is closed, so an open
// page never loses the chunks it was built with ("updates on next launch").
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Every in-app route opens the cached app shell, so the installed app starts offline.
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html"), {
  denylist: [/^\/api\//, /^\/ws/, /^\/livekit\//, /^\/manifest\.webmanifest$/],
}));

type PushPayload = { title: string; body: string; url: string; tag: string; icon?: string };

// Always show the notification: Safari revokes subscriptions whose pushes show
// nothing. The server already skips people who are using the app.
self.addEventListener("push", (event) => {
  let p: PushPayload;
  try {
    p = event.data?.json() as PushPayload;
    if (typeof p?.title !== "string") throw new Error("bad payload");
  } catch {
    p = { title: "Datrope", body: "", url: "/", tag: "datrope" };
  }
  // The server's icon when it has one (the server sends it), else Datrope's.
  event.waitUntil(self.registration.showNotification(p.title, {
    body: p.body, tag: p.tag, icon: p.icon || "/icons/pwa-192x192.png", badge: "/icons/pwa-64x64.png", data: { url: p.url },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? "/";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows[0];
    if (open) {
      await open.focus();
      open.postMessage({ type: "navigate", url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
