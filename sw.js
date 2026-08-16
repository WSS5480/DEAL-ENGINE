/* Deal Engine service worker.
 *
 * Three different caching rules, because the three kinds of request want
 * opposite things:
 *
 *   the app itself   network first, cache as backup   — a deploy must show up
 *   county records   network only                     — never serve stale money
 *   aerial tiles     cache first                      — imagery from 2024 is
 *                                                       the same imagery today
 */
var VERSION = "de-2026-08-16-w";
var SHELL   = VERSION + "-shell";
var TILES   = "de-tiles";
var TILE_MAX = 400;               // roughly 25 MB of imagery, then oldest go

var PRECACHE = [
  "./", "./index.html", "./calc.html", "./manifest.json", "./config.js?v=23",
  "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(SHELL)
      .then(function (c) { return c.addAll(PRECACHE); })
      /* one missing file must not sink the whole install */
      .catch(function () {})
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== SHELL && k !== TILES) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function trim(cacheName, max) {
  caches.open(cacheName).then(function (c) {
    c.keys().then(function (keys) {
      if (keys.length <= max) return;
      for (var i = 0; i < keys.length - max; i++) c.delete(keys[i]);
    });
  });
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  /* county appraisal records — always live, never cached. A stale market value
     is worse than no market value. */
  if (/services9\.arcgis\.com|services\d*\.arcgis\.com|hub\.arcgis\.com/.test(url.hostname)) {
    return;                                   // straight to the network
  }

  /* aerial imagery — immutable, so serve from disk and skip the round trip */
  if (url.hostname === "services.arcgisonline.com") {
    e.respondWith(
      caches.open(TILES).then(function (c) {
        return c.match(req).then(function (hit) {
          if (hit) return hit;
          return fetch(req).then(function (res) {
            if (res && res.status === 200) { c.put(req, res.clone()); trim(TILES, TILE_MAX); }
            return res;
          }).catch(function () {
            return new Response("", { status: 504 });
          });
        });
      })
    );
    return;
  }

  /* the flag file is the freshest thing in the app — never serve it from cache */
  if (url.pathname.endsWith("/flags.json")) return;

  if (url.origin !== self.location.origin) return;

  /* the app — network first so a fresh deploy always wins, cache as the
     fallback so it still opens on a job site with no signal */
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200 && res.type === "basic") {
        var copy = res.clone();
        caches.open(SHELL).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || caches.match("./index.html");
      });
    })
  );
});
