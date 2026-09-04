// Minimal service worker — exists primarily to satisfy PWA installability
// criteria (Chrome/Edge require an active service worker with a fetch
// handler before offering the "install" prompt). Deliberately does NOT
// cache app code (index.html, scripts.js, wordGame.js, etc.): getting that
// caching wrong would risk serving stale JS indefinitely to anyone who
// already has this service worker installed, which is a far worse failure
// mode than "no offline support yet." Only the icon files are precached.
// Bump this cache version whenever any icon is redesigned so installed
// copies replace the previous artwork promptly.
const CACHE_NAME = "japanese-dictionary-static-v1";
const PRECACHE_URLS = [
  "Resources/Icons/android-chrome-192x192.png",
  "Resources/Icons/android-chrome-512x512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

// Network-first for everything — a deployed update is visible immediately
// whenever the user is online, exactly like before this service worker
// existed. The cache is only ever consulted as an offline fallback, and
// only the icons above will actually be found there.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request).catch(async () => {
      // caches.match() resolves to undefined for anything not precached —
      // true of nearly everything, since only the icons above are.
      // respondWith(undefined) throws ("Failed to convert value to
      // 'Response'"), turning an ordinary failure (e.g. a request the
      // browser cancelled because a newer navigation superseded it) into
      // an uncaught exception and a hard network-error response instead of
      // just letting that fetch quietly lose. Response.error() reports the
      // same "nothing to serve" outcome without the throw.
      const cached = await caches.match(event.request);
      return cached || Response.error();
    }),
  );
});
