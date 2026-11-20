/* Removal worker. Versions up to 0.3.0 registered a service worker with an offline cache; the
 * browser keeps checking this URL for updates of that worker. This version replaces it, deletes
 * its cache, unregisters itself and reloads open pages, so every load comes from the server again.
 * It has no fetch handler: requests go straight to the network.
 * Keep the file published until the phones that opened an old version have opened the app once. */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('dl-ble-monitor-')).map((k) => caches.delete(k)));
    await self.registration.unregister();
    const pages = await self.clients.matchAll({ type: 'window' });
    pages.forEach((c) => c.navigate(c.url));
  })());
});
