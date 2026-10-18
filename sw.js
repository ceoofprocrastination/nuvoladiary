// Nuvola Diary — service worker
// Only caches the app shell (this same-origin HTML/CSS/JS/icon). It never touches
// the CDN model files WebLLM/Transformers.js download — those are cached by the
// browser's own Cache Storage usage inside those libraries, independent of this file.

const CACHE = 'nuvola-shell-v3';
const SHELL = ['./index.html', './app.html', './manifest.webmanifest', './icon.svg', './landing.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin GET requests for the app shell. Everything else
  // (CDN scripts, model weight files, cross-origin requests) passes straight
  // through to the network untouched.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(event.request, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
