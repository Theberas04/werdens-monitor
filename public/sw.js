// Werdens Monitor — houdt alleen de schil bij; gegevens komen altijd van de server.
const CACHE = 'werdens-monitor-v1';
const SCHIL = ['/', '/index.html', '/favicon.svg', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SCHIL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((namen) => Promise.all(namen.filter((n) => n !== CACHE).map((n) => caches.delete(n)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && (url.pathname === '/' || url.pathname === '/index.html')) {
      const kopie = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, kopie));
    }
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html'))));
});