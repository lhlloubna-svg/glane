// Service worker : installation de l'app, message hors connexion, notifications
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(
    fetch(e.request).catch(() => new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;padding:40px;background:#F2F1EE;color:#171615"><h2>You\'re offline</h2><p>Glane needs a connection. Try again in a moment.</p></body>',
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    ))
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || "Glane", {
      body: d.body || "",
      icon: "/icon-192.png?v=2",
      badge: "/icon-192.png?v=2",
      tag: d.tag || "glane",
      data: { url: d.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of windows) {
      if ("navigate" in w) {
        try {
          await w.navigate(url);
          return w.focus();
        } catch {
          // fenêtre non contrôlée : on en ouvre une nouvelle
        }
      }
    }
    return self.clients.openWindow(url);
  })());
});
