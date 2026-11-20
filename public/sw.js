// Minimal service worker: caches the app shell so the POS page still loads when the internet drops.
// (Offline *billing* is handled in the page: orders queue in localStorage and replay with the same client_id.)
const CACHE = 'rbs-shell-v1', SHELL = ['/app.html', '/style.css', '/common.js', '/app.js', '/socket.io/socket.io.js'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}))));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/') || (u.pathname.startsWith('/socket.io/') && u.pathname !== '/socket.io/socket.io.js')) return;
  e.respondWith(fetch(e.request).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request)));
});
