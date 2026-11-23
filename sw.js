"use strict";
/* Harangszó service worker: makes the public map installable and usable offline.
   - The map's app shell is precached per build and served from the cache; a new build waits until the page
     asks it to take over ("skipWaiting"), so the page can offer "Új verzió érhető el · Frissítés".
   - The self-hosted fonts (fonts/) are precached once into their own cache, kept across builds and served from it
     to every page; bump FONT_CACHE when a file in fonts/ changes.
   - Everything else goes to the network untouched (the worker does not answer): Supabase, Google Maps, map
     tiles, CDNs, the parish portal and admin (plebania.*, admin.*, schedule-editor.js), and anything else those pages load.
   - Church data stays in the page's own localStorage cache. pages.yml stamps the build id below on deploy. */
const BUILD = "__BUILD__";
const CACHE = "harangszo-" + BUILD;
const FONT_CACHE = "harangszo-fonts-1";
const SHELL = ["./", "index.html", "styles.css", "app.js", "analytics.js", "calendar.js", "data.js", "config.js", "manifest.webmanifest",
  "icons/bell.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-touch-icon-180.png"];
// Every face the map can use (latin-ext carries Hungarian ő ű), so it reads the same offline.
const FONTS = ["fonts/source-sans-3-latin.woff2", "fonts/source-sans-3-latin-ext.woff2", "fonts/newsreader-latin.woff2", "fonts/newsreader-latin-ext.woff2"];
const NETWORK_ONLY = /(^|\/)(plebania\.[^/]*|admin\.[^/]*|schedule-editor\.js)$/;
const SCOPE = new URL(self.registration.scope).pathname; // "/harangszo/" on GitHub Pages, "/" locally

self.addEventListener("install", e => {
  // cache: "reload" skips the HTTP cache, so a new build never precaches an older file.
  e.waitUntil(Promise.all([
    caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))),
    // Fonts only when missing: a new build does not download them again.
    caches.open(FONT_CACHE).then(async c => {
      const missing = [];
      for (const f of FONTS) if (!(await c.match(new URL(f, self.registration.scope).href))) missing.push(f);
      return c.addAll(missing);
    }),
  ]));
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
  if (url.origin !== location.origin || !url.pathname.startsWith(SCOPE)) return; // network only
  const rel = url.pathname.slice(SCOPE.length);
  if (FONTS.includes(rel)) return e.respondWith(caches.open(FONT_CACHE).then(c => c.match(new URL(rel, self.registration.scope).href)).then(hit => hit || fetch(req)));
  if (NETWORK_ONLY.test(rel)) return;
  // The portal and admin load styles.css, calendar.js and config.js too: always fresh from the network for them.
  if (req.referrer && NETWORK_ONLY.test(new URL(req.referrer).pathname)) return;
  const key = rel === "" || rel === "index.html" ? "index.html" : rel;
  if (!SHELL.includes(key)) return;
  e.respondWith(caches.open(CACHE)
    .then(c => c.match(new URL(key, self.registration.scope).href, { ignoreSearch: true }))
    .then(hit => hit || fetch(req)));
});
