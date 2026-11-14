"use strict";
/* Harangszó service worker: makes the public map installable and usable offline.
   - The map's app shell is precached per build and served from the cache; a new build waits until the page
     asks it to take over ("skipWaiting"), so the page can offer "Új verzió érhető el · Frissítés".
   - Google Fonts: stale-while-revalidate.
   - Everything else goes to the network untouched (the worker does not answer): Supabase, Google Maps, map
     tiles, CDNs, the parish portal and admin (plebania.*, admin.*, schedule-editor.js), and anything those pages load.
   - Church data stays in the page's own localStorage cache. pages.yml stamps the build id below on deploy. */
const BUILD = "__BUILD__";
const CACHE = "harangszo-" + BUILD;
const FONT_CACHE = "harangszo-fonts";
const SHELL = ["./", "index.html", "styles.css", "app.js", "analytics.js", "calendar.js", "data.js", "config.js", "manifest.webmanifest",
  "icons/bell.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-touch-icon-180.png"];
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];
const NETWORK_ONLY = /(^|\/)(plebania\.[^/]*|admin\.[^/]*|schedule-editor\.js)$/;
const SCOPE = new URL(self.registration.scope).pathname; // "/harangszo/" on GitHub Pages, "/" locally

self.addEventListener("install", e => {
  // cache: "reload" skips the HTTP cache, so a new build never precaches an older file.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("harangszo-") && k !== CACHE && k !== FONT_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", e => { if (e.data === "skipWaiting") self.skipWaiting(); });

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (FONT_HOSTS.includes(url.hostname)) return e.respondWith(fonts(e));
  if (url.origin !== location.origin || !url.pathname.startsWith(SCOPE)) return; // network only
  const rel = url.pathname.slice(SCOPE.length);
  if (NETWORK_ONLY.test(rel)) return;
  // The portal and admin load styles.css, calendar.js and config.js too: always fresh from the network for them.
  if (req.referrer && NETWORK_ONLY.test(new URL(req.referrer).pathname)) return;
  const key = rel === "" || rel === "index.html" ? "index.html" : rel;
  if (!SHELL.includes(key)) return;
  e.respondWith(caches.open(CACHE)
    .then(c => c.match(new URL(key, self.registration.scope).href, { ignoreSearch: true }))
    .then(hit => hit || fetch(req)));
});

async function fonts(e) {
  const cache = await caches.open(FONT_CACHE);
  const hit = await cache.match(e.request);
  const fresh = fetch(e.request).then(res => {
    if (res.ok || res.type === "opaque") cache.put(e.request, res.clone()).catch(() => { });
    return res;
  });
  if (hit) { e.waitUntil(fresh.catch(() => { })); return hit; }
  return fresh;
}
