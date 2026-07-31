/* Pol Sathkara — Coconut Zone Guide
   Offline-first service worker with a safe update path.

   Strategy
   - Navigations (HTML): network-first, falling back to the cached shell. A new
     deploy is always picked up when online, and the app still opens offline.
   - Same-origin assets: cache-first.
   - Cross-origin libraries/fonts: stale-while-revalidate.
   - Map tiles: cache-first into a separate, size-capped cache, so tiles a farmer
     has already viewed stay available in the field without unbounded growth.

   All URLs are resolved relative to this file, so the app works when served from
   a subpath (GitHub Pages project sites are served at /<repo>/).
*/

// Only the shell is versioned. Map tiles and crop guides are immutable content keyed
// by URL, and they are the expensive things to reacquire: a grower who cached them
// for field use would otherwise lose the lot on every release, exactly when there may
// be no signal to fetch them again. They persist across upgrades instead.
var VERSION = 'v5';
var SHELL_CACHE = 'pol-shell-' + VERSION;
var ASSET_CACHE = 'pol-assets';
var TILE_CACHE = 'pol-tiles';
var TILE_LIMIT = 400;
var KEEP = [SHELL_CACHE, ASSET_CACHE, TILE_CACHE];

// Leaflet and its marker images are part of the shell, not optional extras: without
// them the map tabs cannot render at all, so they are precached alongside the HTML.
var SHELL_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function (c) {
      // Added individually rather than with addAll: addAll is atomic, so a single
      // missing asset would discard the entire precache and block installation.
      return Promise.all(SHELL_URLS.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        // Drop superseded shells, and the older versioned asset/tile caches from
        // before these were made version-independent.
        if (KEEP.indexOf(k) === -1) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isTile(url) {
  return /arcgisonline\.com|basemaps\.cartocdn\.com|tile\.openstreetmap\.org/.test(url.host);
}

// Keep the tile cache bounded (oldest first) so offline map browsing cannot fill the disk.
function trimCache(name, limit) {
  return caches.open(name).then(function (c) {
    return c.keys().then(function (keys) {
      if (keys.length <= limit) return;
      return Promise.all(keys.slice(0, keys.length - limit).map(function (k) {
        return c.delete(k);
      }));
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 1. Navigations: network first, cached shell as fallback.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(SHELL_CACHE).then(function (c) { c.put('./index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (r) {
          return r || caches.match('./').then(function (r2) { return r2 || Response.error(); });
        });
      })
    );
    return;
  }

  // 2. Map tiles: cache first, capped.
  if (isTile(url)) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          var copy = res.clone();
          caches.open(TILE_CACHE).then(function (c) {
            c.put(req, copy).then(function () { trimCache(TILE_CACHE, TILE_LIMIT); });
          });
          return res;
        });
      })
    );
    return;
  }

  // 3. NASA POWER climatology: cache-first and long-lived. It is a 30-year mean, so
  // it does not change between visits, and a grower offline in the field should still
  // see the figures for a point they have already looked at.
  if (/power\.larc\.nasa\.gov/.test(url.host)) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.status === 200) {
            var copy = res.clone();
            caches.open(ASSET_CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        }).catch(function () { return hit; });
      })
    );
    return;
  }

  // 4. Department of Agriculture reference data: administrative divisions and season
  // definitions, which change rarely. Cache-first, and fall back to the cached copy if
  // the service is down, so a locality picker still works in the field.
  if (/(^|\.)doa\.gov\.lk$/.test(url.host)) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.status === 200) {
            var copy = res.clone();
            caches.open(ASSET_CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        }).catch(function () { return hit; });
      })
    );
    return;
  }

  // 5. Crop guide PDFs: cached on first open, never precached. Together they are
  // several megabytes, and a grower needs only the crops they actually grow — but
  // once opened, the guide must still be there in the field with no signal.
  if(/\/intercrop-pdfs\/.+\.pdf$/i.test(url.pathname)){
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.status === 200) {
            var copy = res.clone();
            caches.open(ASSET_CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        });
      })
    );
    return;
  }

  // 6. Same-origin assets: cache first.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.status === 200) {
            var copy = res.clone();
            caches.open(ASSET_CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        });
      })
    );
    return;
  }

  // 7. Cross-origin libraries/fonts: stale-while-revalidate.
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && (res.status === 200 || res.type === 'opaque')) {
          var copy = res.clone();
          caches.open(ASSET_CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});

// Lets the page ask whether the shell is cached, instead of guessing cache names.
self.addEventListener('message', function (e) {
  if (!e.data || e.data.type !== 'cache-status') return;
  caches.open(SHELL_CACHE).then(function (c) {
    return c.match('./index.html').then(function (r) {
      var reply = { type: 'cache-status', cached: !!r, date: r ? r.headers.get('date') : null };
      if (e.source && e.source.postMessage) e.source.postMessage(reply);
    });
  });
});
