// Service Worker: hält die App-Dateien offline verfügbar (Lager mit schlechtem Empfang).
// Gilt für beide Apps: Konfektionierung (./) und Abrechnung (./abrechnung/).
// Die Daten selbst cacht Firebase (Firestore-Offline-Cache) – Anfragen an Firebase laufen hier nicht durch.
// Bei jeder neuen Version CACHE hochzählen, damit installierte Apps die neuen Dateien laden.
const CACHE = 'konf-v16';
const FIREBASE = 'https://www.gstatic.com/firebasejs/10.12.2/';
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/store.js',
  './js/ui.js',
  './js/config.js',
  './js/files.js',
  './js/lieferschein.js',
  './js/umlagerung.js',
  './js/abrechnung.js',
  './js/rechnung.js',
  './manifest.webmanifest',
  './abrechnung/',
  './abrechnung/index.html',
  './abrechnung/manifest.webmanifest',
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
  // PDF-Anzeige (pdf.js) wird erst beim ersten PDF geladen und dann aufbewahrt.
  const vendor = sameOrigin && new URL(request.url).pathname.includes('/vendor/');
  if (!sameOrigin && !firebaseLib) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: sameOrigin });
      // Firebase-Bibliotheken und pdf.js sind versioniert und ändern sich nie → Cache genügt.
      if (cached && (firebaseLib || vendor)) return cached;
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
