'use strict';

/* Production and beta are served from the SAME github.io origin, and Cache
   Storage is origin-scoped. Derive the channel from this worker's own path so
   each channel owns a disjoint set of cache names and can never evict the
   other's cache. */
const CHANNEL = self.location.pathname.includes('-beta') ? '-beta' : '';

/* Bump CACHE on every deploy so updates reach installed phones. */
const CACHE = 'lizard-blockdoku' + CHANNEL + '-v14';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './game.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];
/* Beta-only assets (manifest-beta.webmanifest, icons/icon-beta-*.png) are
   intentionally NOT precached: they are install-time-only and fetched online,
   so production installs never download beta bytes. The fetch handler below
   falls through to the network on a cache miss, which is all they need. */

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      /* cache: 'reload' bypasses the HTTP cache, otherwise GitHub Pages'
         max-age=600 can pin stale assets into a freshly bumped cache. */
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  /* Only delete OUR OWN channel's stale caches: *.github.io is a shared origin
     and both channels live on it. The production prefix 'lizard-blockdoku-v'
     and the beta prefix 'lizard-blockdoku-beta-v' are mutually exclusive (a
     production cache name never starts with the beta prefix and vice versa),
     so this cleanup can never evict the other channel's install. */
  const PREFIX = 'lizard-blockdoku' + CHANNEL + '-v';
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n.startsWith(PREFIX) && n !== CACHE).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  /* Never serve cross-origin requests (the leaderboard API) from the app cache. */
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || fetch(event.request))
  );
});
