const VERSION = 'v3.7.0';
const PREFIX = 'kaizen-yly-';
const STATIC_CACHE = `${PREFIX}static-${VERSION}`;
const RUNTIME_CACHE = `${PREFIX}runtime-${VERSION}`;
const MAX_RUNTIME_ENTRIES = 60;
const NAV_TIMEOUT_MS = 2500;     // مهلة الصفحة قبل الرجوع للكاش
const ASSET_TIMEOUT_MS = 3000;   // مهلة ملفات المشروع قبل الرجوع للكاش

const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
];

// لازم تتطابق حرفياً مع الروابط المستخدمة في index.html
const CDN_ASSETS = [
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone/babel.min.js',
  'https://cdn.tailwindcss.com',
  'https://www.gstatic.com/firebasejs/10.8.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth-compat.js',
];

// ---------- Install ----------
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await Promise.allSettled(CORE_ASSETS.map((url) => cache.add(url)));
    await Promise.allSettled(
      CDN_ASSETS.map((url) => cache.add(new Request(url, { mode: 'cors' })))
    );
  })());
});

// ---------- Activate: مسح الكاش القديم ----------
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

// شبكة أولاً (لتظهر التحديثات) مع مهلة، وبعدها الكاش لو الشبكة بطيئة أو مقطوعة
async function networkFirst(event, cacheName) {
  const request = event.request;
  const cached = await caches.match(request);

  const networkPromise = fetch(request).then(async (res) => {
    if (res && res.ok) {
      const cache = await caches.open(cacheName);
      await cache.put(request, res.clone());
      trimCache(cacheName, MAX_RUNTIME_ENTRIES);
    }
    return res;
  });
  networkPromise.catch(() => {}); // منع أخطاء غير معالجة لو خسرت السباق
  event.waitUntil(networkPromise.catch(() => {}));

  if (!cached) return networkPromise;

  try {
    return await Promise.race([networkPromise, timeout(ASSET_TIMEOUT_MS)]);
  } catch {
    return cached;
  }
}

// الصفحات: شبكة أولاً ثم كاش
async function handleNavigation(event) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const preload = event.preloadResponse ? await event.preloadResponse : null;
    const res = preload || (await Promise.race([fetch(event.request), timeout(NAV_TIMEOUT_MS)]));
    if (res && res.ok) cache.put('./index.html', res.clone());
    return res;
  } catch {
    return (
      (await cache.match('./index.html')) ||
      (await cache.match('./')) ||
      (await cache.match(event.request)) ||
      Response.error()
    );
  }
}

// ---------- Fetch ----------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (!url.protocol.startsWith('http')) return;
  if (request.headers.has('range')) return;

  // بيانات Firebase / Google / Cloudinary بلا كاش نهائياً
  if (
    url.hostname.endsWith('googleapis.com') ||
    url.hostname.endsWith('firebaseio.com') ||
    url.hostname.endsWith('firebaseapp.com') ||
    url.hostname.endsWith('cloudinary.com') ||
    url.hostname.includes('identitytoolkit')
  ) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  const isSameOrigin = url.origin === self.location.origin;
  const isKnownCDN = CDN_ASSETS.includes(request.url);

  if (isSameOrigin) {
    event.respondWith(networkFirst(event, RUNTIME_CACHE));
  } else if (isKnownCDN) {
    // مكتبات الـ CDN: كاش أولاً لسرعة الفتح
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request))
    );
  }
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
