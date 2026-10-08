// Kubelab CKA — caché para uso sin conexión. Cambia VERSION al publicar cambios.
const VERSION = 'kubelab-v2';
const ASSETS = ['./', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png',
  'js/vendor/js-yaml.min.js', 'js/core.js', 'js/sim.js', 'js/kubectl.js', 'js/shell.js', 'js/content.js', 'js/tasks.js', 'js/coach.js', 'js/quiz.js', 'js/plan.js', 'js/app.js'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // red primero (para recibir actualizaciones), caché si no hay conexión
  e.respondWith(fetch(e.request).then((r) => { if (r.ok && new URL(e.request.url).origin === location.origin) { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, cp)); } return r; }).catch(() => caches.match(e.request).then((m) => m || caches.match('index.html'))));
});
