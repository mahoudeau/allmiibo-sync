// Service worker for allmiibo-sync — makes the site work offline.
//
// Uses a cache-on-install, network-first-with-cache-fallback strategy:
// - On install: cache all static assets the site needs to render
// - On fetch: try network first, fall back to cache
//
// Cache version is tied to the build stamp so a deploy clears old caches.

const VERSION = 'v1';

// Everything needed to render the full site offline.
const PRECACHE = [
  '/',
  '/index.html',
  '/collection.html',
  '/sync.html',
  '/help.html',
  '/changelog.html',
  '/legal.html',
  '/amiibo.html',
  '/manifest.webmanifest',
  '/favicon.svg',

  // CSS
  '/css/app.css',
  '/css/collection.css',
  '/css/amiibodetail.css',

  // JS
  '/js/amiibo.js',
  '/js/amiibodetail.js',
  '/js/amiibopanel.js',
  '/js/artwork.js',
  '/js/ble.js',
  '/js/bundle.js',
  '/js/bundlesource.js',
  '/js/bytes.js',
  '/js/changelogui.js',
  '/js/chrome.js',
  '/js/collectiongrid.js',
  '/js/collectionui.js',
  '/js/collectionview.js',
  '/js/dbdiff.js',
  '/js/dbsource.js',
  '/js/devicepath.js',
  '/js/devicepicker.js',
  '/js/dialog.js',
  '/js/fca.js',
  '/js/footer.js',
  '/js/header.js',
  '/js/icons.js',
  '/js/localfs.js',
  '/js/overlay.js',
  '/js/planner.js',
  '/js/prefs.js',
  '/js/probe.js',
  '/js/protocol.js',
  '/js/repair.js',
  '/js/rescue.js',
  '/js/sprite.js',
  '/js/sync.js',
  '/js/syncflow.js',
  '/js/syncui.js',
  '/js/tutorial.js',
  '/js/ui.js',
  '/js/version.js',
  '/js/writetest.js',

  // Data
  '/data/amiibo-db.js',
  '/data/changelog.js',
  '/data/hhd-cards.js',

  // Fonts
  '/fonts/press-start-2p/PressStart2P-Regular.woff2',

  // Icons
  '/icons/favicon-32.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/og.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Only handle GET requests to our own origin.
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache a copy of successful responses for next time.
        const clone = response.clone();
        caches.open(VERSION).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
