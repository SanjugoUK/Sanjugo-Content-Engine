// Minimal service worker — its main job is just making ContentFlow installable as an app.
// Strategy is deliberately "network first": always get the freshest app/data when online,
// and only fall back to the cached shell if the network is actually unreachable. This avoids
// the classic PWA bug where people get stuck on a stale cached version after an update.

const CACHE_NAME = "contentflow-shell-v1";
const SHELL_FILES = ["/", "/manifest.json", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Never intercept API calls — those must always hit the real server.
  if (request.url.includes("/api/")) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Keep the shell cache warm with same-origin successful responses.
        if (request.method === "GET" && response.ok && new URL(request.url).origin === self.location.origin) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match("/")))
  );
});
