// Task 9: installable map — manifest and icons, service worker (offline shell, never admin/portal), the offline note,
// the "no data yet" state, the update toast and the install menu item. Live mode against the fake Supabase.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, devices } from "./helpers/playwright.mjs";
import { ROOT } from "./helpers/server.mjs";
import { startPwaServer } from "./helpers/pwa-server.mjs";
import { mockSupabase } from "./helpers/supabase-mock.mjs";

let server, browser;
before(async () => { server = await startPwaServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.stop(); });

const { defaultBrowserType: _, ...IPHONE } = devices["iPhone 13"];
const { defaultBrowserType: __, ...PIXEL } = devices["Pixel 7"];
const NOW = new Date("2026-11-09T06:30:00+01:00"); // a Monday morning
// Two churches as public_data returns them (see fromDb in app.js).
const CHURCHES = [
  { id: 101, name: "Szent István-bazilika", city: "Budapest", address: "Szent István tér 1.", rite: "rk", lat: 47.5009, lon: 19.0539, imp: 90,
    services: [{ kind: "mass", days: [0, 1, 2, 3, 4, 5, 6], start: "18:00" }, { kind: "confession", days: [1], start: "17:00", end: "17:45" }] },
  { id: 102, name: "Ferences templom", city: "Budapest", address: "Ferenciek tere 9.", rite: "rk", lat: 47.4925, lon: 19.0560, imp: 80,
    services: [{ kind: "mass", days: [1, 2, 3, 4, 5], start: "07:00" }, { kind: "mass", days: [0], start: "10:00" }] },
];

async function open({ view = IPHONE, init, url = "/index.html?sw=1", data = CHURCHES, abortData = false, routes } = {}) {
  const context = await browser.newContext({ ...view, timezoneId: "Europe/Budapest" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  if (init) await page.addInitScript(init);
  await page.clock.setFixedTime(NOW);
  const { calls } = await mockSupabase(page, { rpc: { public_data: () => data } });
  if (abortData) await page.route("**/rest/v1/rpc/public_data", r => r.abort("internetdisconnected"));
  if (routes) await routes(page);
  await page.goto(server.url + url);
  return { context, page, errors, calls, close: () => context.close() };
}
const controlled = page => page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
const resultNames = page => page.$$eval("#s-results .row .r-name", els => els.map(e => e.textContent));
const pngSize = buf => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

test("manifest and icons", async () => {
  const { page, close } = await open();
  try {
    const href = await page.$eval('link[rel="manifest"]', l => l.href);
    const res = await page.request.get(href);
    assert.equal(res.status(), 200);
    const m = await res.json();
    assert.equal(m.name, "Harangszó");
    assert.equal(m.short_name, "Harangszó");
    assert.equal(m.display, "standalone");
    assert.equal(m.start_url, "./");
    assert.equal(m.scope, "./");
    assert.equal(m.background_color, "#ffffff");
    assert.equal(m.theme_color, "#ffffff");
    assert.equal(m.icons.length, 4);
    assert.equal(m.icons.filter(i => i.purpose === "maskable").length, 1, "one maskable icon");
    for (const icon of m.icons) {
      const r = await page.request.get(new URL(icon.src, href).href);
      assert.equal(r.status(), 200, icon.src);
      assert.match(r.headers()["content-type"], /^image\/png/, icon.src);
      const { w, h } = pngSize(await r.body());
      assert.equal(`${w}x${h}`, icon.sizes, icon.src);
    }
    assert.equal(await page.$eval('meta[name="theme-color"]', m => m.content), "#ffffff");
    assert.equal(await page.$eval('meta[name="theme-color"][media]', m => m.content), "#0e0e0e");
    const apple = await page.$eval('link[rel="apple-touch-icon"]', l => l.href);
    assert.equal((await page.request.get(apple)).status(), 200);
  } finally { await close(); }
});

test("service worker controls the map", async () => {
  const { page, errors, calls, close } = await open();
  try {
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await controlled(page);
    assert.equal(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL), server.url + "/sw.js");
    // Supabase is left to the network: the page's own mock still answers it under the worker.
    await page.waitForSelector("#m-name");
    assert.ok(calls.filter(c => c.path === "/rest/v1/rpc/public_data").length >= 2, "public_data fetched on both loads");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("offline: the map comes from the worker, the list from the data cache", async () => {
  const { context, page, errors, close } = await open();
  try {
    await controlled(page);
    await page.waitForFunction(() => { try { return !!localStorage.getItem("harangszo-data-v2"); } catch (_) { return false; } });
    assert.ok(await page.locator("#offnote").isHidden(), "no offline note while online");
    // Losing and regaining the connection shows and hides the note.
    await context.setOffline(true);
    await page.waitForSelector("#offnote:not([hidden])");
    await context.setOffline(false);
    await page.waitForSelector("#offnote[hidden]", { state: "attached" });
    await page.route("**/rest/v1/rpc/public_data", r => r.abort("internetdisconnected"));
    await context.setOffline(true);
    const res = await page.reload();
    assert.ok(res.fromServiceWorker(), "index.html served by the service worker");
    await page.waitForSelector("#m-name");
    assert.ok(await page.locator("#offnote").isVisible(), "offline note shown");
    assert.equal(await page.locator("#offnote").textContent(), "Nincs internet · a lista működik");
    await page.click("#m-search");
    await page.waitForFunction(() => document.querySelectorAll("#s-results .row").length === 2);
    assert.deepEqual((await resultNames(page)).sort(), CHURCHES.map(c => c.name).sort());
    // The scope root works offline too.
    const root = await page.goto(server.url + "/?sw=1");
    assert.ok(root.fromServiceWorker());
    assert.ok(await page.locator("#offnote").isVisible());
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("offline: admin and the parish portal are never served from the cache", async () => {
  const { context, page, close } = await open();
  try {
    await controlled(page);
    const cached = await page.evaluate(async () => {
      const out = [];
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname);
      return out;
    });
    assert.ok(cached.includes("/app.js"), "the shell is precached");
    for (const k of cached) assert.doesNotMatch(k, /admin|plebania|schedule-editor/, `cached: ${k}`);
    // Online, the portal's shared files come from the network, not from the map's cache.
    const fromSw = {};
    page.on("response", r => { const u = new URL(r.url()); if (u.origin === server.url) fromSw[u.pathname] = r.fromServiceWorker(); });
    await page.goto(server.url + "/plebania.html");
    await page.waitForLoadState("load");
    assert.equal(fromSw["/plebania.html"], false);
    assert.equal(fromSw["/styles.css"], false, "styles.css for the portal from the network");
    assert.equal(fromSw["/calendar.js"], false, "calendar.js for the portal from the network");
    await page.goto(server.url + "/index.html?sw=1");
    assert.equal(fromSw["/styles.css"], true, "styles.css for the map from the cache");
    await context.setOffline(true);
    for (const p of ["/admin.html", "/plebania.html"]) {
      const res = await page.goto(server.url + p).catch(e => e);
      assert.ok(res instanceof Error, `${p} must not load offline`);
    }
  } finally { await close(); }
});

test("no data yet", async () => {
  // Review Focus 5: nothing cached and public_data unreachable (as when offline).
  const { page, errors, close } = await open({ abortData: true });
  try {
    await page.waitForFunction(() => /internet/.test(document.querySelector("#panel .ui-empty")?.textContent || ""), null, { timeout: 5000 });
    assert.equal(await page.locator("#panel .ui-empty").textContent(),
      "Nincs internetkapcsolat, és még nincs elmentett templomlista ezen az eszközön. Csatlakozz az internethez, és frissítsd az oldalt.");
    assert.doesNotMatch(await page.locator("#panel").textContent(), /betöltése/, "no loading text left");
    assert.equal(await page.locator("#m-name, #panel .row").count(), 0, "Most shows no church");
    assert.match(await page.locator("#mapcard").textContent(), /internet/, "the map's panel says the same");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("first visit offline: note and explanation, no spinner", async () => {
  const offline = () => Object.defineProperty(Navigator.prototype, "onLine", { get: () => false, configurable: true });
  const { page, close } = await open({ abortData: true, init: offline, url: "/index.html" });
  try {
    await page.waitForSelector("#offnote:not([hidden])", { timeout: 5000 });
    await page.waitForFunction(() => /internet/.test(document.querySelector("#panel .ui-empty")?.textContent || ""), null, { timeout: 5000 });
  } finally { await close(); }
});

test("a server error is not reported as no internet", async () => {
  const { page, close } = await open({ routes: page => page.route("**/rest/v1/rpc/public_data", r => r.fulfill({ status: 500, contentType: "application/json", body: "{}" })) });
  try {
    await page.waitForFunction(() => /Nem sikerült/.test(document.querySelector("#panel .ui-empty")?.textContent || ""), null, { timeout: 5000 });
  } finally { await close(); }
});

test("new version: toast, then the new worker takes over", async () => {
  server.build = "build-a";
  const { page, errors, close } = await open();
  try {
    await controlled(page);
    assert.ok(await page.locator("#update").evaluate(e => !e.classList.contains("on")), "no toast for the first install");
    server.build = "build-b";
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()));
    await page.waitForSelector("#update.on", { timeout: 15000 });
    assert.equal((await page.locator("#update").innerText()).replace(/\s+/g, " ").replace(" ×", "").trim(), "Új verzió érhető el · Frissítés");
    await Promise.all([page.waitForEvent("load", { timeout: 15000 }), page.click("#update-btn")]);
    await controlled(page);
    const keys = await page.evaluate(() => caches.keys());
    assert.ok(keys.includes("harangszo-build-b"), keys.join());
    assert.ok(!keys.includes("harangszo-build-a"), "old cache deleted");
    assert.ok(await page.locator("#update").evaluate(e => !e.classList.contains("on")));
    assert.deepEqual(errors, []);
  } finally { server.build = null; await close(); }
});

test("update toast can be dismissed", async () => {
  server.build = "build-c";
  const { page, close } = await open();
  try {
    await controlled(page);
    server.build = "build-d";
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()));
    await page.waitForSelector("#update.on", { timeout: 15000 });
    await page.click("#update-x");
    assert.ok(await page.locator("#update").evaluate(e => !e.classList.contains("on")));
  } finally { server.build = null; await close(); }
});

test("install: iPhone Safari gets the how-to sheet", async () => {
  const { page, errors, close } = await open({ init: () => Object.defineProperty(Navigator.prototype, "standalone", { get: () => false, configurable: true }) });
  try {
    const btn = page.locator("#install-btn");
    await btn.scrollIntoViewIfNeeded();
    assert.ok(await btn.isVisible());
    assert.equal(await btn.textContent(), "Telepítés a kezdőképernyőre");
    await btn.click();
    await page.waitForSelector("dialog#install[open]");
    assert.equal(await page.locator("#install-h").textContent(), "Telepítés iPhone-ra");
    const steps = await page.$$eval("#install .steps li", els => els.map(e => e.textContent.trim()));
    assert.deepEqual(steps, ["1Koppints a Megosztás gombra a Safari alsó sávjában.", "2Válaszd: Főképernyőhöz adás."]);
    await page.click("#install-done");
    await page.waitForSelector("dialog#install:not([open])");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("install: hidden when installed, and on desktop without a prompt", async () => {
  const standalone = await open({ init: () => Object.defineProperty(Navigator.prototype, "standalone", { get: () => true, configurable: true }) });
  try {
    assert.ok(await standalone.page.locator("#install-btn").isHidden(), "hidden on a home-screen app");
  } finally { await standalone.close(); }
  const desktop = await open({ view: { viewport: { width: 1440, height: 900 } } });
  try {
    assert.ok(await desktop.page.locator("#install-btn").isHidden(), "hidden without beforeinstallprompt");
  } finally { await desktop.close(); }
});

test("install: Android uses the browser's prompt", async () => {
  const { page, close } = await open({ view: PIXEL });
  try {
    await page.evaluate(() => {
      const e = new Event("beforeinstallprompt");
      e.prompt = () => { window.__prompted = (window.__prompted || 0) + 1; return Promise.resolve(); };
      e.userChoice = Promise.resolve({ outcome: "accepted" });
      window.dispatchEvent(e);
    });
    await page.locator("#install-btn").scrollIntoViewIfNeeded();
    await page.click("#install-btn");
    assert.equal(await page.evaluate(() => window.__prompted), 1);
    assert.ok(await page.locator("dialog#install").evaluate(d => !d.open), "no iPhone sheet on Android");
    assert.ok(await page.locator("#install-btn").isHidden(), "a prompt is used once");
  } finally { await close(); }
});

test("sw.js and pages.yml", () => {
  const sw = readFileSync(path.join(ROOT, "sw.js"), "utf8");
  assert.equal(sw.split("__BUILD__").length - 1, 1, "__BUILD__ exactly once");
  const yml = readFileSync(path.join(ROOT, ".github/workflows/pages.yml"), "utf8");
  const cp = yml.split("\n").find(l => /^\s*cp index\.html /.test(l));
  for (const f of ["sw.js", "manifest.webmanifest", "schedule-editor.js"]) assert.ok(cp.split(/\s+/).includes(f), `cp line lacks ${f}`);
  assert.match(yml, /^\s*cp -r icons _site\/?\s*$/m);
  assert.match(yml, /_site\/sw\.js.*replace\("__BUILD__".*\$GITHUB_SHA/);
});
