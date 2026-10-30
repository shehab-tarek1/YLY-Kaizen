const VERSION = 'v3.4.0'; // تم التحديث لفرض مسح الكاش القديم
const PREFIX = 'kaizen-yly-';
const STATIC_CACHE = `${PREFIX}static-${VERSION}`;
const RUNTIME_CACHE = `${PREFIX}runtime-${VERSION}`;
const MAX_RUNTIME_ENTRIES = 60;
const NAV_TIMEOUT_MS = 2500;

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

// ---------- Install: precache ----------
self.addEventListener('install', (event) => {
  self.skipWaiting(); // تفعيل فوري دون انتظار إغلاق التبويبات
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll(CORE_ASSETS);
    await Promise.allSettled(
      CDN_ASSETS.map((url) => cache.add(new Request(url, { mode: 'cors' })))
    );
  })());
});

// ---------- Activate: مسح أي كاش قديم نهائياً ----------
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

// استراتيجية Network-First للملفات الأساسية لضمان رؤية التحديثات فوراً
async function networkFirst(request, cacheName) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) return cachedResponse;
    throw error;
  }
}

// Navigations: شبكة أولاً ثم كاش
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

  // استبعاد قواعد بيانات Firebase وكلاوديناري من الكاش تماماً لعدم تجميد البيانات
  if (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('cloudinary.com') ||
    url.hostname.includes('identitytoolkit')
  ) {
    return;
  }

  if (!url.protocol.startsWith('http')) return;
  if (request.headers.has('range')) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  const isSameOrigin = url.origin === self.location.origin;
  const isKnownCDN = CDN_ASSETS.some((a) => a === request.url);

  if (isSameOrigin) {
    // ملفات المشروع (app.js, style.css) تجلب الجديد دائماً
    event.respondWith(networkFirst(event.request, RUNTIME_CACHE));
  } else if (isKnownCDN) {
    // مكاتب الـ CDN الخارجية تستخدم الكاش لتسريع الفتح
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});