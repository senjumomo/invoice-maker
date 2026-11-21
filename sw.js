// Offline support: network first (so updates show straight away), falling back to the cache when offline.
const CACHE = 'invoice-maker-v8';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'css/paper.css',
  'js/app.js', 'js/store.js', 'js/calc.js', 'js/render.js', 'js/export.js', 'js/ui.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.open(CACHE).then(async c => {
    try {
      const r = await fetch(e.request, { cache: 'no-cache' });
      if (r.ok) c.put(e.request, r.clone());
      return r;
    } catch {
      return (await c.match(e.request, { ignoreSearch: true })) || (e.request.mode === 'navigate' ? c.match('index.html') : Response.error());
    }
  }));
});
