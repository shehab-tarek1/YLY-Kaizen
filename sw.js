const VERSION = 'v2.1.0';
const PREFIX = 'kaizen-yly-';
const STATIC_CACHE = `${PREFIX}static-${VERSION}`;
const RUNTIME_CACHE = `${PREFIX}runtime-${VERSION}`;
const MAX_RUNTIME_ENTRIES = 60;
const NAV_TIMEOUT_MS = 3000;

const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
];

const CDN_ASSETS = [
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://cdn.tailwindcss.com',
];

// ---------- Install: precache (a failing CDN won't break installation) ----------
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll(CORE_ASSETS); // core files are required
    await Promise.allSettled(
      CDN_ASSETS.map((url) => cache.add(new Request(url, { mode: 'cors' })))
    );
    await self.skipWaiting();
  })());
});

// ---------- Activate: clean old caches + enable navigation preload ----------
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable();
    }
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith(PREFIX) && k !== STATIC_CACHE && k !== RUNTIME_CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// ---------- Helpers ----------
async function trimCache(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > max) {
    await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
  }
}

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

// Stale-while-revalidate: instant from cache, refresh in background
async function staleWhileRevalidate(event, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(event.request);

  const network = fetch(event.request)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) {
        cache.put(event.request, res.clone());
        if (cacheName === RUNTIME_CACHE) trimCache(RUNTIME_CACHE, MAX_RUNTIME_ENTRIES);
      }
      return res;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(network); // keep SW alive until the background update finishes
    return cached;
  }
  return (await network) || Response.error();
}

// Navigations: network (with timeout) -> cache -> offline index.html
async function handleNavigation(event) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const preload = event.preloadResponse ? await event.preloadResponse : null;
    const res = preload || (await Promise.race([fetch(event.request), timeout(NAV_TIMEOUT_MS)]));
    if (res && res.ok) cache.put(event.request, res.clone());
    return res;
  } catch {
    return (
      (await cache.match(event.request)) ||
      (await cache.match('./index.html')) ||
      (await cache.match('./')) ||
      Response.error()
    );
  }
}

// ---------- Fetch routing ----------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (!url.protocol.startsWith('http')) return;
  if (request.headers.has('range')) return; // let media range requests go straight to network

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  const isSameOrigin = url.origin === self.location.origin;
  const isKnownCDN = CDN_ASSETS.some((a) => a === request.url);

  if (isKnownCDN) {
    event.respondWith(staleWhileRevalidate(event, STATIC_CACHE));
  } else if (isSameOrigin) {
    event.respondWith(staleWhileRevalidate(event, RUNTIME_CACHE));
  }
  // anything else (APIs, analytics, etc.) is not intercepted
});

// ---------- Allow the page to trigger an update ----------
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
