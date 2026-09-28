// Service worker — makes Creator Studio installable as an app, and receives push alerts (bottom of file).
// Strategy is deliberately "network first": always get the freshest app/data when online,
// and only fall back to the cached shell if the network is actually unreachable. This avoids
// the classic PWA bug where people get stuck on a stale cached version after an update.

const CACHE_NAME = "contentflow-shell-v2";
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
      Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== "contentflow-push").map((k) => caches.delete(k)))
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

// Push alerts (Settings → Notifications). The server sends { title, body, url, tag }, encrypted to this device.
// Every push must show a notification — Safari cancels the subscription of sites that stay silent.
self.addEventListener("push", (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch (e) { msg = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(
    self.registration.showNotification(msg.title || "Creator Studio", {
      body: msg.body || "You have a new update.",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: msg.tag || undefined,
      renotify: !!msg.tag,
      data: { url: msg.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      // The app listens for hash changes, so this switches page without a reload.
      if (win.navigate) { try { await win.navigate(target); return; } catch (e) {} }
      win.postMessage({ type: "open", url: target });
      return;
    }
    await self.clients.openWindow(target);
  })());
});

// A browser can rotate a subscription on its own; re-register the new one under the same person.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const old = event.oldSubscription;
    const res = await fetch("/api/push/key");
    const { publicKey } = await res.json();
    const raw = atob(publicKey.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((publicKey.length + 3) % 4));
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)) });
    const owner = await (await caches.open("contentflow-push")).match("/push-owner");
    const userId = owner ? await owner.text() : "";
    if (old) await fetch("/api/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: old.endpoint }) });
    if (userId) await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON(), userId }) });
  })().catch(() => {}));
});
