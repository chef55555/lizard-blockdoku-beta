'use strict';

/* Bump CACHE on every deploy so updates reach installed phones. */
const CACHE = 'lizard-blockdoku-v4';
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
  event.waitUntil(
    caches.keys()
      /* Only touch our own caches: *.github.io is a shared origin. */
      .then((names) => Promise.all(
        names.filter((n) => n.startsWith('lizard-blockdoku-') && n !== CACHE).map((n) => caches.delete(n))
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
