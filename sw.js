/* Botany Lab service worker — app shell cache, offline-first */
const CACHE = "botany-lab-v1";
const SHELL = [
  ".", "index.html", "css/app.css", "js/app.js",
  "manifest.webmanifest", "icons/icon.svg",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;                    // never intercept sync POSTs
  if (url.origin !== location.origin && !url.hostname.includes("fonts.")) return;

  // fonts: cache-first (immutable); app shell: network-first so deploys land, cache when offline
  if (url.hostname.includes("fonts.")){
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
      return res;
    })));
    return;
  }
  // bypass the HTTP cache (GH Pages max-age=600) so deploys land immediately;
  // offline falls back to the sw cache
  e.respondWith(
    fetch(e.request, { cache: "no-store" }).then(res => {
      if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request).then(hit => hit || caches.match("index.html")))
  );
});
