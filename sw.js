/* Service worker: offline cache for the whole app.
 * Strategy "network first, cache fallback" for same-origin GET:
 *   online  -> always the latest files (fast test cycle), the cache is refreshed in passing
 *   offline -> the cached copy, so the app keeps working after one online visit
 */
importScripts('./version.js');

const CACHE = `dl-ble-monitor-${self.APP_VERSION}`;
const NETWORK_TIMEOUT_MS = 2500;
const FILES = [
  './',
  './index.html',
  './version.js',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/ble.js',
  './js/decode.js',
  './js/legacy.js',
  './js/protocol.js',
  './js/session.js',
  './js/sim.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('dl-ble-monitor-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await withTimeout(fetch(req, { cache: 'no-store' }), NETWORK_TIMEOUT_MS);
    if (res.ok) {
      cache.put(req, res.clone());
      return res;
    }
    // server down behind a proxy / tunnel (e.g. 404, 502, 530): keep the saved copy
    return (await cache.match(req, { ignoreSearch: true })) || res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) {
      return hit;
    }
    if (req.mode === 'navigate') {
      return (await cache.match('./index.html')) || Response.error();
    }
    return Response.error();
  }
}

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (err) => { clearTimeout(t); reject(err); });
  });
}
