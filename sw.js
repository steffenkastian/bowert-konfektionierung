// Service Worker: hält die App-Dateien offline verfügbar (Lager mit schlechtem Empfang).
// Die Daten selbst cacht Firebase (Firestore-Offline-Cache) – Anfragen an Firebase laufen hier nicht durch.
// Bei jeder neuen Version CACHE hochzählen, damit installierte Apps die neuen Dateien laden.
const CACHE = 'konf-v2';
const FIREBASE = 'https://www.gstatic.com/firebasejs/10.12.2/';
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/store.js',
  './js/ui.js',
  './js/config.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  `${FIREBASE}firebase-app.js`,
  `${FIREBASE}firebase-auth.js`,
  `${FIREBASE}firebase-firestore.js`,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache: 'reload' umgeht den Browser-Cache, damit wirklich die neue Version geladen wird.
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const sameOrigin = new URL(request.url).origin === self.location.origin;
  const firebaseLib = request.url.startsWith(FIREBASE);
  if (!sameOrigin && !firebaseLib) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: sameOrigin });
      // Firebase-Bibliotheken sind versioniert und ändern sich nie → Cache genügt.
      if (cached && firebaseLib) return cached;
      // Eigene Dateien: sofort aus dem Cache, im Hintergrund aktualisieren.
      const fresh = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});
