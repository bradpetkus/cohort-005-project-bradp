// Cadence service worker. It handles phone push only: no caching, no offline
// mode, no fetch handler.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Every push must show a notification, or Safari revokes the subscription.
self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = {};
  }

  const title = message.title || "Cadence";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: message.body || "",
      // Bundled events share a tag, so a newer push replaces the older one
      // without buzzing again.
      tag: message.tag || undefined,
      renotify: false,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: message.url || "/" },
    })
  );
});

// Focus an open Cadence window and take it to the destination, or open one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(
    (event.notification.data && event.notification.data.url) || "/",
    self.location.origin
  ).href;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ("navigate" in client) await client.navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});
