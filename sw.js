// Service worker minimal : rend l'app installable et affiche un message propre hors connexion
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(
    fetch(e.request).catch(() => new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;padding:40px;background:#F7F5FA;color:#1B1622"><h2>Pas de connexion</h2><p>Glane a besoin d\'internet. Réessaie dans un instant.</p></body>',
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    ))
  );
});
