// Service worker for allmiibo-sync — makes the site work offline.
//
// Three caches:
//   static-v1     — precached at install (HTML, CSS, JS, fonts, icons, data)
//   runtime-v1    — artwork and other images fetched at runtime
//
// Bump the version suffix to clear all caches on deploy.

const VERSION_SUFFIX = 'v1';

const STATIC = `static-${VERSION_SUFFIX}`;
const RUNTIME = `runtime-${VERSION_SUFFIX}`;

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
  '/offline.html',
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
    caches.open(STATIC)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== STATIC && k !== RUNTIME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Artwork and images: cache in the runtime store, capped at ~500 entries.
  // Network-first so users always see up-to-date artwork when online.
  if (url.pathname.startsWith('/data/images/')) {
    event.respondWith(
      caches.open(RUNTIME).then((cache) =>
        fetch(event.request)
          .then((response) => {
            if (response.ok) {
              cache.put(event.request, response.clone());
              // Prune oldest entries if we hit the cap.
              cache.keys().then((keys) => {
                if (keys.length > 500) {
                  cache.delete(keys[0]);
                }
              });
            }
            return response;
          })
          .catch(() => cache.match(event.request))
      )
    );
    return;
  }

  // Everything else: network-first, fall back to static cache.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return fetch(event.request)
        .then((response) => {
          if (response.ok) {
            caches.open(STATIC).then((cache) => cache.put(event.request, response.clone()));
          }
          return response;
        })
        .catch(() => cached || caches.match('/offline.html'))
    });
  );
});
