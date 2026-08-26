const CACHE_NAME = 'newform-v2';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './assets/hero.png',
  './assets/mandhi.png',
  './assets/alfaham.png',
  './assets/beeffry.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((res) => res || fetch(e.request))
  );
});
