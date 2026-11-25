// "Indulások", the home: the navy header (day · time · place, the church-year line, Mind / Mise / Gyónás), the amber
// pass (the Mass or confession to leave for now, with the church's photo and its credit), the board (ranked by start
// time, the walk built in, "most tart" red only while something goes on, amber "indulj" only from the visitor's own
// position), the board reranking as minutes pass (FLIP) and a changed row held in amber, the empty states, the type
// and the dark board. Live mode against the fake Supabase; Wednesday 25 November 2026, 17:48, Budapest.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, devices } from "./helpers/playwright.mjs";
import { startServer, ROOT } from "./helpers/server.mjs";
import { mockSupabase } from "./helpers/supabase-mock.mjs";
import { typeProblems } from "./helpers/type-check.mjs";

const { defaultBrowserType: _, ...IPHONE } = devices["iPhone 13"];
const DATA = JSON.parse(readFileSync(new URL("./fixtures/board-churches.json", import.meta.url), "utf8"));
const NOW = new Date("2026-11-25T17:48:00+01:00");
const HERE = { latitude: 47.5062, longitude: 19.0392 }; // Batthyány tér
const JPG = readFileSync(path.join(ROOT, "icons/icon-512.png"));
const AMBER = "rgb(255, 183, 3)", RED = "rgb(211, 58, 44)";

let server, browser;
before(async () => { server = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.stop(); });

// geo: the visitor allows their position and taps "Saját helyzetem" (it is never asked for on load).
async function open({ data = DATA, now = NOW, geo = true, colorScheme = "light", view = IPHONE, reducedMotion = "no-preference" } = {}) {
  const context = await browser.newContext({ ...view, timezoneId: "Europe/Budapest", colorScheme, reducedMotion, serviceWorkers: "block",
    ...(geo ? { geolocation: geo === true ? HERE : geo, permissions: ["geolocation"] } : {}) });
  const page = await context.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  const { calls } = await mockSupabase(page, { rpc: { public_data: () => data, track: () => null } });
  await page.route(/upload\.wikimedia\.org\/test\//, r => r.fulfill({ status: 200, contentType: "image/png", body: JPG }));
  await page.clock.setFixedTime(now);
  await page.goto(server.url + "/index.html");
  await page.locator("#i-rows li, #i-empty .board-empty, .pass").first().waitFor({ timeout: 15000 });
  if (geo) { await page.locator("#i-locate").click(); await page.locator("#i-line", { hasText: "a helyzeted" }).waitFor(); }
  return { page, errors, calls, close: () => context.close() };
}
const rows = page => page.$$eval("#i-rows .brow", bs => bs.map(b => [b.querySelector(".b-t").textContent, b.querySelector(".b-name").textContent,
  b.querySelector(".b-sub").textContent, b.querySelector(".b-w").textContent, b.querySelector(".chip").textContent, b.querySelector(".chip").className.replace("chip ", "")]));
const at = (page, hm) => page.clock.setFixedTime(new Date(`2026-11-25T${hm}:00+01:00`)).then(() => page.evaluate(() => render()));

test("header: Indulások, the day · time · place line, the church-year line, Mind / Mise / Gyónás", async () => {
  const { page, errors, calls, close } = await open({ geo: false });
  try {
    assert.equal(await page.locator(".bhead h1").textContent(), "Indulások");
    assert.equal(await page.locator("#i-line").textContent(), "Szerda, nov. 25. · 17:48 · Budapest", "no position yet: the chosen town, said plainly");
    assert.equal(await page.locator("#i-lit").textContent(), "Évközi 34. hét · vasárnap: Advent 1. vasárnapja");
    assert.deepEqual(await page.$$eval("#i-seg button", bs => bs.map(b => [b.textContent, b.getAttribute("aria-pressed")])), [["Mind", "true"], ["Mise", "false"], ["Gyónás", "false"]]);
    assert.equal(await page.locator(".bhead").evaluate(e => getComputedStyle(e).backgroundColor), "rgb(19, 35, 63)");
    // The position is asked for only from the control, never on load.
    assert.ok(await page.locator("#i-locate").isVisible());
    assert.equal(await page.locator("#i-locate").textContent(), "Saját helyzetem");
    assert.ok(!calls.some(c => /locate/.test(JSON.stringify(c.body || ""))), "nothing about a position is sent");
    await page.context().grantPermissions(["geolocation"]); await page.context().setGeolocation(HERE);
    await page.locator("#i-locate").click();
    await page.locator("#i-line", { hasText: "a helyzeted" }).waitFor();
    assert.equal(await page.locator("#i-line").textContent(), "Szerda, nov. 25. · 17:48 · a helyzeted");
    assert.ok(await page.locator("#i-locate").isHidden());
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("the pass: the earliest Mass you can still reach on foot, with its photo, credit and Útvonal", async () => {
  const { page, errors, close } = await open();
  try {
    assert.equal(await page.locator("#i-st").textContent(), "Indulj 17:58");
    assert.equal(await page.locator("#i-time").textContent(), "18:00");
    assert.equal(await page.locator("#i-name").textContent(), "Árpád-házi Szent Erzsébet-templom");
    assert.equal(await page.locator("#i-meta").textContent(), "szentmise · 140 m · 2 perc gyalog");
    assert.equal(await page.locator(".pass").evaluate(e => getComputedStyle(e).backgroundColor), AMBER);
    assert.match(await page.locator("#i-dir").getAttribute("href"), /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=47\.5049,19\.0391$/);
    const img = page.locator(".pass .ph img.ph-img");
    assert.equal(await img.count(), 1);
    assert.deepEqual(await img.evaluate(i => ({ src: i.src, alt: i.alt, fit: getComputedStyle(i).objectFit })),
      { src: "https://upload.wikimedia.org/test/erzsebet.jpg", alt: "Árpád-házi Szent Erzsébet-templom", fit: "cover" });
    const credit = page.locator(".pass .ph-credit");
    assert.equal(await credit.textContent(), "Fotó: tesztkép · CC BY-SA 4.0 · Wikimedia Commons");
    assert.equal(await credit.getAttribute("href"), "https://commons.wikimedia.org/wiki/File:Teszt_Erzsebet.jpg");
    assert.equal(await credit.getAttribute("target"), "_blank");
    assert.match(await credit.getAttribute("rel"), /noopener/);
    assert.ok(await credit.isVisible(), "the credit shows over the photo");
    // The whole pass opens the church page.
    await page.locator(".pass-open").click();
    await page.locator('.detail[data-id="402"] .ph img').waitFor();
    assert.equal(await page.locator(".detail .ph-credit").textContent(), "Fotó: tesztkép · CC BY-SA 4.0 · Wikimedia Commons");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("a parish photo without a file page has a plain credit; without a photo there is no image and no placeholder", async () => {
  const parish = DATA.map(c => c.id === 402 ? { ...c, photo_credit: "Fotó: a plébánia", photo_page: null } : c);
  let t = await open({ data: parish });
  try {
    assert.equal(await t.page.locator(".pass .ph-credit").evaluate(e => e.tagName), "SPAN");
    assert.equal(await t.page.locator(".pass .ph-credit").textContent(), "Fotó: a plébánia");
  } finally { await t.close(); }
  t = await open({ data: DATA.map(({ photo_url, ...c }) => c) });
  try {
    assert.equal(await t.page.locator("#panel img").count(), 0);
    assert.equal(await t.page.locator("#panel .ph").count(), 0);
    assert.equal(await t.page.locator("#i-name").textContent(), "Árpád-házi Szent Erzsébet-templom");
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test("the board: by start time, the walk, a time twice shown once, red only for what goes on, amber only to leave soon", async () => {
  const { page, errors, close } = await open();
  try {
    assert.deepEqual(await page.$$eval("#i-cols span", s => s.map(e => e.textContent)), ["Idő", "Templom", "Séta", "Állapot"]);
    const r = await rows(page);
    assert.deepEqual(r.slice(0, 5), [
      ["16:30", "Szent Anna-templom", "gyónás 18:15-ig", "1 p", "most tart", "now"],
      ["17:00", "Országúti Ferences templom", "szentségimádás 19:00-ig", "9 p", "most tart", "now"],
      ["18:00", "Mátyás-templom", "szentmise", "7 p", "indulj 17:53", "go"],
      ["18:00", "Krisztinavárosi Havas Boldogasszony-templom", "szentmise", "15 p", "12 perc", "ok"],
      ["18:30", "Szent Anna-templom", "szentmise", "1 p", "42 perc", "ok"],
    ]);
    assert.equal(r.filter(x => x[1] === "Mátyás-templom" && x[0] === "18:00").length, 1, "two rules at 18:00 (one in German): one row");
    assert.ok(!r.some(x => x[1] === "Árpád-házi Szent Erzsébet-templom"), "the pass's Mass is not repeated on the board");
    assert.ok(!r.some(x => x[0] === "07:00" || x[0] === "17:00" && x[1] === "Mátyás-templom"), "nothing that is over");
    for (let i = 1; i < r.length; i++) assert.ok(r[i - 1][0] <= r[i][0], `ranked by start time: ${r[i - 1][0]} before ${r[i][0]}`);
    // Beyond half an hour's walk the column says km; an hour or more ahead the status is the time to leave.
    assert.deepEqual(r.find(x => x[1] === "Sziklatemplom").slice(3), ["28 p", "19:32-kor", "ok"]);
    assert.deepEqual(r.find(x => x[1] === "Szent István-bazilika" ).slice(3, 5), ["15 p", "18:45-kor"]);
    // Every element that paints itself red is a "most tart" chip; amber is the pass and the "indulj" chips.
    const paint = await page.evaluate(([RED, AMBER]) => [...document.querySelectorAll("#col *, #tabs *")].filter(e => e.checkVisibility()).flatMap(e => {
      const s = getComputedStyle(e), ps = getComputedStyle(e.parentElement), out = [];
      if ((s.color === RED && ps.color !== RED) || s.backgroundColor === RED || (s.borderTopColor === RED && parseFloat(s.borderTopWidth) > 0)) out.push("red:" + e.className);
      if (s.backgroundColor === AMBER) out.push("amber:" + e.className);
      return out;
    }), [RED, AMBER]);
    assert.deepEqual([...new Set(paint)].sort(), ["amber:chip go", "amber:pass", "red:chip now"]);
    // A row opens its church.
    await page.locator('#i-rows .brow[data-id="403"]').click();
    await page.locator('.detail[data-id="403"]').waitFor();
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("without the visitor's position: measured from the town, said plainly, and no amber to leave", async () => {
  const { page, errors, close } = await open({ geo: false });
  try {
    assert.equal(await page.locator("#i-st").textContent(), "Következő");
    assert.equal(await page.locator("#i-name").textContent(), "Mátyás-templom");
    assert.equal(await page.locator("#i-rows .chip.go").count(), 0, "no 'indulj' from a town's default point");
    assert.ok(await page.locator("#i-rows .chip.now").count() > 0, "'most tart' still shows");
    assert.equal(await page.locator("#i-origin-sel").inputValue(), "Budapest");
    // Another town from the origin row: the board is measured from there.
    await page.locator("#i-origin-sel").selectOption("Debrecen");
    await page.locator("#i-line", { hasText: "Debrecen" }).waitFor();
    assert.equal(await page.locator(".board-empty h2").textContent(), "A közelben nincs ismert templom");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("Mise and Gyónás: the board and the pass follow the segment", async () => {
  const { page, close } = await open();
  try {
    await page.locator('#i-seg [data-nk="mass"]').click();
    assert.equal(await page.locator('#i-seg [data-nk="mass"]').getAttribute("aria-pressed"), "true");
    assert.ok((await rows(page)).every(r => /szentmise/.test(r[2])), "only Masses");
    assert.equal(await page.locator("#i-name").textContent(), "Árpád-házi Szent Erzsébet-templom");
    await page.locator('#i-seg [data-nk="conf"]').click();
    assert.ok((await rows(page)).every(r => /^gyónás/.test(r[2])), "only confessions");
    assert.equal(await page.locator("#i-name").textContent(), "Belvárosi Ferences templom", "the confession you can still reach on foot");
    assert.equal(await page.locator("#i-meta").textContent(), "gyónás 19:30-ig · 2,0 km · 24 perc gyalog");
  } finally { await close(); }
});

test("the pass falls back to the nearest one still to come, then to one going on; the board says when nothing is left", async () => {
  // A Saturday afternoon with two churches (the earlier Közel most data).
  const sat = [
    { id: 201, name: "Mátyás-templom", city: "Budapest", address: "Szentháromság tér 2.", rite: "rk", lat: 47.502, lon: 19.0344, imp: 90,
      services: [{ kind: "mass", days: [6], start: "18:00" }, { kind: "mass", days: [6], start: "18:00", note: "németül" }, { kind: "mass", days: [6], start: "08:00" }] },
    { id: 202, name: "Szent Anna-templom", city: "Budapest", address: "Batthyány tér 7.", rite: "rk", lat: 47.5065, lon: 19.0385, imp: 80,
      services: [{ kind: "mass", days: [6], start: "18:30" }, { kind: "confession", days: [6], start: "17:00", end: "17:45" }] },
    { id: 203, name: "Kapucinus templom", city: "Budapest", address: "Fő utca 32.", rite: "rk", lat: 47.5045, lon: 19.0390, imp: 70, services: [{ kind: "mass", days: [6], start: "07:00" }] },
  ];
  const { page, errors, close } = await open({ data: sat, now: new Date("2026-11-14T17:10:00+01:00"), geo: { latitude: 47.5055, longitude: 19.0375 } });
  try {
    assert.equal(await page.locator("#i-name").textContent(), "Mátyás-templom");
    assert.deepEqual((await rows(page)).map(r => r.slice(0, 3).concat(r[5])), [["17:00", "Szent Anna-templom", "gyónás 17:45-ig", "now"], ["18:30", "Szent Anna-templom", "szentmise", "ok"]]);
    assert.equal(await page.locator("#i-rows .brow", { hasText: "Kapucinus" }).count(), 0, "a church with nothing left today is not listed");
    // Gyónás: the only confession is going on: it becomes the pass, "Most tart".
    await page.locator('#i-seg [data-nk="conf"]').click();
    assert.equal(await page.locator("#i-st").textContent(), "Most tart");
    assert.equal(await page.locator("#i-name").textContent(), "Szent Anna-templom");
    assert.equal(await page.locator("#i-rows li").count(), 0);
    assert.equal(await page.locator(".board-empty h2").textContent(), "Utána ma már nincs más");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("an empty evening: no pass, the board says so in the same voice and offers Keresés", async () => {
  const { page, errors, close } = await open({ now: new Date("2026-11-25T21:30:00+01:00") });
  try {
    assert.equal(await page.locator(".pass").count(), 0);
    assert.equal(await page.locator("#i-rows li").count(), 0);
    assert.ok(await page.locator("#i-cols").isHidden());
    assert.equal(await page.locator(".board-empty h2").textContent(), "Ma már nincs több indulás");
    assert.match(await page.locator(".board-empty p").textContent(), /^A közelben ma már nincs ismert szentmise vagy gyóntatás\./);
    await page.locator('.board-empty [data-tabgo="list"]').click();
    await page.locator("#q").waitFor();
    assert.equal(await page.locator('.tab[aria-pressed="true"]').textContent(), "Keresés");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("as minutes pass the rows rerank in place (FLIP on the spring) and a changed row holds its amber until the next tap", async () => {
  const { page, errors, close } = await open();
  try {
    const before = await page.$$eval("#i-rows li", ls => ls.map(l => l.dataset.key));
    const kept = await page.evaluate(() => { window.__li = document.querySelector('#i-rows li[data-key^="404|conf"]'); return !!window.__li; });
    assert.ok(kept);
    // 17:54: Mátyás's leaving time (17:53) has passed: its status changes from amber to grey and the row is marked.
    await at(page, "17:54");
    const m = page.locator('#i-rows li[data-key^="403|"]');
    assert.equal(await m.locator(".chip").textContent(), "6 perc");
    assert.equal(await m.getAttribute("class"), "changed");
    assert.equal(await m.evaluate(e => getComputedStyle(e).animationName), "flash");
    // It holds through the next minute's render…
    await at(page, "17:55");
    assert.equal(await m.getAttribute("class"), "changed");
    // …and clears on the next tap.
    await page.locator(".bhead h1").dispatchEvent("pointerdown");
    assert.equal(await page.locator("#i-rows li.changed").count(), 0);
    // 18:01: the 18:00 Masses have left; the rows below move up from where they were, on the spring.
    await at(page, "18:01");
    const flips = await page.evaluate(() => document.getAnimations().filter(a => a.id === "flip").map(a => ({ d: a.effect.getTiming().duration, e: a.effect.getTiming().easing })));
    assert.ok(flips.length > 0, "rows move");
    for (const f of flips) { assert.equal(f.d, 350); assert.match(f.e, /^linear\(0( 0%)?, /); }
    const after = await page.$$eval("#i-rows li", ls => ls.map(l => l.dataset.key));
    assert.ok(!after.some(k => /\|18:00\|/.test(k)), "the 18:00 rows are gone");
    assert.ok(await page.evaluate(() => document.querySelector('#i-rows li[data-key^="404|conf"]') === window.__li), "a row keeps its element when it moves");
    assert.notDeepEqual(after, before);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("reduced motion: no rows move; the change is still marked, without the flash", async () => {
  const { page, close } = await open({ reducedMotion: "reduce" });
  try {
    await at(page, "17:54");
    assert.equal(await page.locator('#i-rows li[data-key^="403|"]').getAttribute("class"), "changed");
    assert.equal(await page.locator('#i-rows li[data-key^="403|"]').evaluate(e => getComputedStyle(e).animationName), "none");
    await at(page, "18:01");
    assert.equal(await page.evaluate(() => document.getAnimations().filter(a => a.id === "flip").length), 0);
  } finally { await close(); }
});

test("tabs: Indulások · Térkép · Keresés · Mentett, Indulások first", async () => {
  const { page, close } = await open({ geo: false });
  try {
    assert.deepEqual(await page.$$eval(".tab", els => els.map(e => [e.textContent.trim(), e.dataset.tab, e.getAttribute("aria-pressed")])),
      [["Indulások", "most", "true"], ["Térkép", "map", "false"], ["Keresés", "list", "false"], ["Mentett", "saved", "false"]]);
  } finally { await close(); }
});

test("dark mode: a navy-black board, the same amber and red", async () => {
  const { page, close } = await open({ colorScheme: "dark" });
  try {
    const r = await page.evaluate(() => { const c = s => getComputedStyle(document.querySelector(s));
      return { body: getComputedStyle(document.body).backgroundColor, head: c(".bhead").backgroundColor, name: c("#i-rows .b-name").color, pass: c(".pass").backgroundColor,
        passInk: c("#i-time").color, now: c(".chip.now").backgroundColor, go: c(".chip.go").color, filter: c(".ph-img").filter }; });
    assert.deepEqual(r, { body: "rgb(11, 19, 34)", head: "rgb(19, 35, 63)", name: "rgb(233, 238, 247)", pass: AMBER, passInk: "rgb(20, 33, 61)", now: RED, go: "rgb(58, 42, 0)", filter: "none" });
  } finally { await close(); }
});

// Overpass for everything at 400/600/700/800; the search tab and the church page too.
for (const view of ["iPhone 13", "1440x900"]) test(`type: Overpass only, four weights (${view})`, async () => {
  const { page, close } = await open({ view: view === "1440x900" ? { viewport: { width: 1440, height: 900 } } : IPHONE });
  try {
    await page.evaluate(() => document.fonts.ready);
    assert.deepEqual(await typeProblems(page), [], "Indulások");
    assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.querySelector("#i-time")).fontWeight, getComputedStyle(document.querySelector(".bhead h1")).fontWeight,
      getComputedStyle(document.querySelector("#i-rows .b-t")).fontVariantNumeric]), ["800", "800", "tabular-nums"]);
    await page.locator('.tab[data-tab="list"]').click(); await page.locator("#s-results .brow").first().waitFor();
    assert.deepEqual(await typeProblems(page), [], "Keresés");
    await page.locator("#s-results .brow").first().click(); await page.locator(".detail").waitFor();
    assert.deepEqual(await typeProblems(page), [], "church page");
    const loaded = await page.evaluate(() => [...new Set([...document.fonts].filter(f => f.status === "loaded").map(f => f.family.replace(/"/g, "")))]);
    assert.deepEqual(loaded, ["Overpass"]);
  } finally { await close(); }
});

test("the church-year line and the names of Sundays", async () => {
  const { page, close } = await open({ geo: false });
  try {
    const got = await page.evaluate(() => ({
      weeks: Object.fromEntries([[2026, 10, 14], [2026, 10, 29], [2026, 11, 7], [2026, 11, 25], [2026, 0, 12], [2026, 1, 18], [2026, 1, 22], [2026, 2, 29], [2026, 3, 5], [2026, 3, 12], [2026, 4, 25], [2026, 10, 22]]
        .map(([y, m, d]) => [`${y}-${m + 1}-${d}`, litWeek(new Date(y, m, d))])),
      sundays: Object.fromEntries([[2026, 10, 29], [2026, 10, 22], [2026, 4, 31], [2026, 3, 12], [2026, 2, 1], [2026, 5, 14], [2026, 5, 7], [2026, 11, 27]]
        .map(([y, m, d]) => [`${y}-${m + 1}-${d}`, sundayName(new Date(y, m, d))])),
      lines: [litLine(new Date(2026, 10, 25)), litLine(new Date(2026, 10, 22)), litLine(new Date(2026, 10, 2)), litLine(new Date(2026, 10, 1))],
    }));
    assert.deepEqual(got.weeks, {
      "2026-11-14": "Évközi 32. hét", "2026-11-29": "Advent 1. hete", "2026-12-7": "Advent 2. hete", "2026-12-25": "Karácsonyi idő", "2026-1-12": "Évközi 1. hét",
      "2026-2-18": "Nagyböjt", "2026-2-22": "Nagyböjt 1. hete", "2026-3-29": "Nagyhét", "2026-4-5": "Húsvét nyolcada", "2026-4-12": "Húsvéti idő 2. hete",
      "2026-5-25": "Évközi 8. hét", "2026-11-22": "Évközi 34. hét",
    });
    assert.deepEqual(got.sundays, { "2026-11-29": "Advent 1. vasárnapja", "2026-11-22": "Krisztus Király", "2026-5-31": "Szentháromság vasárnapja", "2026-4-12": "Húsvét 2. vasárnapja",
      "2026-3-1": "Nagyböjt 2. vasárnapja", "2026-6-14": "Évközi 11. vasárnap", "2026-6-7": "Úrnapja", "2026-12-27": null });
    assert.deepEqual(got.lines, ["Évközi 34. hét · vasárnap: Advent 1. vasárnapja", "Krisztus Király", "Évközi 31. hét · Halottak napja", "Mindenszentek"]);
  } finally { await close(); }
});

test("the map's amber pin is the pass's church from the visitor's own position, never from a town's default point", async () => {
  const { page, close } = await open({ geo: false });
  try {
    await page.context().grantPermissions(["geolocation"]); await page.context().setGeolocation(HERE);
    await page.locator('.tab[data-tab="map"]').click();
    await page.locator(".leaflet-marker-icon").first().waitFor({ state: "attached", timeout: 15000 });
    await page.waitForTimeout(600);
    assert.equal(await page.locator('[class*="mk-next"]').count(), 0, "from the default Budapest point nothing is amber");
    assert.ok(await page.locator("#mapcard.go").isVisible(), "the mini pass shows the pass");
    await page.locator("#locate-btn").click();
    await page.locator(".mk-next").first().waitFor({ state: "attached", timeout: 15000 });
    assert.match(await page.locator(".mk-next").first().textContent(), /^18:00 Árpád-házi Szent Erzs/);
    assert.equal(await page.locator(".mk-next").first().evaluate(e => getComputedStyle(e).backgroundColor), AMBER);
    assert.equal(await page.locator(".mkclu, .mk-on").first().evaluate(e => getComputedStyle(e).backgroundColor), "rgb(19, 35, 63)", "the other markers are navy");
  } finally { await close(); }
});
