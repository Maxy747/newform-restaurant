// NEWFORM service worker. The build (vite.config.js → offlineManifest) fills in BUILD with the exact
// files each page needs; in `vite dev` it stays null and only the basic shell is cached.
const BUILD = /*__NEWFORM_BUILD__*/null;

const VERSION = BUILD ? BUILD.version : 'dev';
const PRECACHE = `newform-${VERSION}`;
const RUNTIME = `newform-runtime-${VERSION}`;
const GROUPS = BUILD ? BUILD.groups : { site: ['./', './index.html', './manifest.json', './icons/icon-192.png'], admin: [], invoice: [] };
// Font Awesome and the web fonts come from these hosts; keep a copy so icons show offline.
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
// Pages served without ".html" (Cloudflare Pages) share one cached copy with the ".html" name.
const PAGES = ['admin', 'invoice'];

// Only this site's own pages (not e.g. /classic/, which has its own worker) are kept.
const SCOPE = new URL('./', self.location.href).pathname;
const pageKey = url => {
  const path = new URL(url, self.location.href).pathname;
  if (!path.startsWith(SCOPE)) return null;
  const name = path.slice(SCOPE.length).replace(/\.html$/, '');
  if (name === '' || name === 'index') return './index.html';
  return PAGES.includes(name) ? `./${name}.html` : null;
};

// A redirected response can't answer a navigation, so store a clean copy.
async function clean(response) {
  if (!response.redirected) return response;
  return new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function cacheGroup(name) {
  const cache = await caches.open(PRECACHE);
  await Promise.all((GROUPS[name] || []).map(async url => {
    if (await cache.match(url)) return;
    const response = await fetch(url, { cache: 'reload' });
    if (response.ok) await cache.put(url, await clean(response));
  }));
}

self.addEventListener('install', (e) => {
  self.skipWaiting();
  // Customers only get the site shell; the admin console asks for its own files (see 'message').
  e.waitUntil(cacheGroup('site'));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== PRECACHE && key !== RUNTIME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// The admin page asks for its files (and the invoice page's) to be kept for offline use.
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'cache-groups') return;
  const work = Promise.all((e.data.groups || []).map((name) => cacheGroup(name)))
    .then(() => ({ ok: true }), (error) => ({ ok: false, error: String(error) }))
    .then((result) => e.ports?.[0]?.postMessage(result));
  e.waitUntil(work);
});

async function fromNetworkThenCache(request) {
  const cache = await caches.open(PRECACHE);
  try {
    const response = await fetch(request);
    const key = pageKey(request.url);
    if (key && response.ok && response.type === 'basic') await cache.put(key, await clean(response.clone()));
    return response;
  } catch (error) {
    const key = pageKey(request.url) || './index.html';
    return (await cache.match(key)) || (await cache.match('./index.html')) || Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME);
  const cached = await cache.match(request);
  const network = fetch(request).then((response) => {
    if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
    return response;
  }).catch(() => cached || Response.error());
  return cached || network;
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: false });
  if (cached) return cached;
  const response = await fetch(request);
  // Hashed build files and icons never change under the same name; keep them as they're used.
  const path = new URL(request.url).pathname;
  if (response.ok && /\/(assets|icons)\//.test(path)) (await caches.open(RUNTIME)).put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (e) => {
  // Never cache authenticated API responses or payment requests.
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) {
    if (CDN_HOSTS.includes(url.hostname)) e.respondWith(staleWhileRevalidate(e.request));
    return;
  }
  if (e.request.mode === 'navigate') { e.respondWith(fromNetworkThenCache(e.request)); return; }
  e.respondWith(cacheFirst(e.request));
});
