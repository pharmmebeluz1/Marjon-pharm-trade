const CACHE = "pharm360-secure-platform-v13";
const STATIC_ASSETS = [
  "/", "/offline.html", "/manifest.webmanifest", "/static/secure.css", "/static/secure-client.js",
  "/assets/pharm360-logo.png", "/assets/icon-192.png", "/assets/icon-512.png", "/assets/pharm360-intro.mp3"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("message", event => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);

  // Never cache authenticated API responses, uploads, reports or non-GET requests.
  if (request.method !== "GET" || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request, {cache: "no-store"})
        .then(response => response)
        .catch(() => caches.match("/").then(response => response || caches.match("/offline.html")))
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request).then(response => {
        if (response.ok && ["style", "script", "image", "audio", "font"].includes(request.destination)) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      }))
    );
  }
});
