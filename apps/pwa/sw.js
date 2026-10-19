// sw.js — offline-first app shell. The whole UI is precached at install, so
// the app opens with zero network. Matrix API calls are NEVER cached here —
// freshness and ordering are matrix-lite's job (sync tokens + outbox).
const VERSION = "huc-v3";
const SHELL = [
  ".",
  "index.html",
  "css/app.css",
  "js/app.js",
  "js/i18n.js",
  "js/render.js",
  "js/map.js",
  "js/push.js",
  "vendor/matrix-lite/client.js",
  "vendor/matrix-lite/store-idb.js",
  "vendor/matrix-lite/media.js",
  "vendor/matrix-lite/e2ee.js",
  "vendor/matrix-lite/calls.js",
  "vendor/matrix-lite/group-calls.js",
  "vendor/matrix-lite/device-sync.js",
  "manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.includes("/_matrix/")) return; // network only, never cached
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});

// Web Push: payload carries NO message content (privacy) — it is a nudge to
// sync. The client syncs, then the notification is shown from local data.
self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window" });
    for (const c of clients) c.postMessage({ type: "push-sync" });
    if (!clients.length) {
      self.registration.showNotification("howUdeyChat", {
        body: "New message from your clinic",
        icon: "",
        tag: "huc-push",
      });
    }
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow("."));
});
