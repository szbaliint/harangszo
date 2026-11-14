// "The church first": the Most home — photo (or none), credit, day line with the liturgical week, the big time,
// red only for the next one, the platform font everywhere, the dark ground. Live mode against the fake Supabase.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, devices } from "./helpers/playwright.mjs";
import { startServer, ROOT } from "./helpers/server.mjs";
import { mockSupabase } from "./helpers/supabase-mock.mjs";

const { defaultBrowserType: _, ...IPHONE } = devices["iPhone 13"];
const NOW = new Date("2026-11-14T16:40:00+01:00"); // a Saturday afternoon
const PHOTO = "https://commons.wikimedia.org/wiki/Special:FilePath/Matthias_Church,_Budapest,_2017.jpg?width=1000";
const CREDIT = "Fotó: Stefan Schäfer · CC BY-SA 4.0 · Wikimedia Commons";
const PAGE = "https://commons.wikimedia.org/wiki/File:Matthias_Church,_Budapest,_2017.jpg";
const PNG = readFileSync(path.join(ROOT, "icons/icon-512.png"));
const church = (extra = {}) => [
  { id: 201, name: "Mátyás-templom", city: "Budapest", address: "Szentháromság tér 2.", rite: "rk", lat: 47.502, lon: 19.0344, imp: 90, website: "matyas-templom.hu",
    services: [{ kind: "mass", days: [6], start: "18:00", tags: ["vigil"] }, { kind: "mass", days: [0], start: "10:00" }], ...extra },
  { id: 202, name: "Szent Anna-templom", city: "Budapest", address: "Batthyány tér 7.", rite: "rk", lat: 47.5065, lon: 19.0385, imp: 80,
    services: [{ kind: "mass", days: [6], start: "18:30" }, { kind: "confession", days: [6], start: "17:00", end: "17:45" }] },
];

let server, browser;
before(async () => { server = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.stop(); });

async function open({ data = church({ photo_url: PHOTO, photo_credit: CREDIT, photo_page: PAGE }), now = NOW, colorScheme = "light", view = IPHONE } = {}) {
  const context = await browser.newContext({ ...view, timezoneId: "Europe/Budapest", colorScheme, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await mockSupabase(page, { rpc: { public_data: () => data, track: () => null } });
  await page.route(/commons\.wikimedia\.org\/wiki\/Special:FilePath/, r => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await page.clock.setFixedTime(now);
  await page.goto(server.url + "/index.html");
  await page.locator("#m-name").waitFor({ timeout: 15000 });
  return { page, errors, close: () => context.close() };
}

test("Most shows the nearest church's photo, with its credit linking to the file page", async () => {
  const { page, errors, close } = await open();
  try {
    const img = page.locator("#panel .most .ph img.ph-img");
    assert.equal(await img.count(), 1);
    const a = await img.evaluate(i => ({ src: i.src, loading: i.getAttribute("loading"), decoding: i.decoding, w: i.getAttribute("width"), h: i.getAttribute("height"), alt: i.alt, fit: getComputedStyle(i).objectFit }));
    assert.deepEqual(a, { src: PHOTO, loading: "eager", decoding: "async", w: "1000", h: "750", alt: "Mátyás-templom", fit: "cover" });
    const credit = page.locator("#panel .ph .ph-credit");
    assert.equal(await credit.textContent(), CREDIT);
    assert.equal(await credit.getAttribute("href"), PAGE);
    assert.equal(await credit.getAttribute("target"), "_blank");
    assert.match(await credit.getAttribute("rel"), /noopener/);
    // About 42% of the screen, edge to edge; Keresés and ♡ over it.
    const r = await page.evaluate(() => ({ ph: document.querySelector(".ph").getBoundingClientRect().toJSON(), vh: innerHeight, vw: innerWidth }));
    assert.ok(Math.abs(r.ph.height / r.vh - 0.42) < 0.03, `photo height ${r.ph.height} of ${r.vh}`);
    assert.equal(r.ph.left, 0); assert.equal(r.ph.width, r.vw);
    assert.equal(await page.locator(".ph #m-search").textContent(), "Keresés");
    assert.equal(await page.locator(".ph #m-save").getAttribute("aria-pressed"), "false");
    // The same photo heads the church page.
    await page.click("#m-week");
    await page.locator('.detail[data-id="201"] .ph img').waitFor();
    assert.equal(await page.locator(".detail .ph-credit").textContent(), CREDIT);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("a parish photo without a file page: the credit is plain text", async () => {
  const { page, close } = await open({ data: church({ photo_url: PHOTO, photo_credit: "Fotó: a plébánia" }) });
  try {
    const credit = page.locator("#panel .ph .ph-credit");
    assert.equal(await credit.evaluate(e => e.tagName), "SPAN");
    assert.equal(await credit.textContent(), "Fotó: a plébánia");
  } finally { await close(); }
});

test("no photo: the same layout without any image", async () => {
  const { page, errors, close } = await open({ data: church() });
  try {
    assert.equal(await page.locator("#panel img").count(), 0, "no image, no placeholder");
    assert.equal(await page.locator("#panel .ph").count(), 0);
    assert.ok(await page.locator(".top-plain #m-search").isVisible());
    assert.ok(await page.locator(".top-plain #m-save").isVisible());
    assert.equal(await page.locator("#m-name").textContent(), "Mátyás-templom");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("facts: day line, the big time with its kind and notes, address, buttons, the times after it", async () => {
  const { page, errors, close } = await open();
  try {
    assert.equal(await page.locator("#m-day").textContent(), "Szombat, november 14. · Évközi 32. hét");
    assert.equal(await page.locator("#m-when .big").textContent(), "18:00");
    assert.equal(await page.locator("#m-when em").textContent(), "Előesti szentmise");
    assert.equal(await page.locator("#m-when .when-side span").textContent(), "vasárnapra érvényes · 1 óra 20 perc múlva");
    assert.equal(await page.locator("#m-when .big").evaluate(e => getComputedStyle(e).fontWeight), "300");
    assert.equal(await page.locator("#m-when .big").evaluate(e => getComputedStyle(e).fontSize), "64px");
    assert.match(await page.locator(".most .addr").textContent(), /^Budapest, Szentháromság tér 2\. · \d+ m, \d+ perc gyalog$/);
    assert.deepEqual(await page.$$eval(".most .acts > *", els => els.map(e => e.textContent)), ["Útvonal", "Heti rend", "Honlap"]);
    assert.equal(await page.locator(".most .sec").textContent(), "Utána a közelben");
    const rows = await page.$$eval(".most .rows .row", els => els.map(e => [e.querySelector(".r-t").textContent, e.querySelector(".r-name").textContent, e.querySelector("small").textContent]));
    assert.deepEqual(rows[0], ["17:00", "Szent Anna-templom", "gyónás · Batthyány tér 7."]);
    assert.deepEqual(rows[1], ["18:30", "Szent Anna-templom", "mise · Batthyány tér 7."]);
    // Heti rend opens the church page with the week unfolded.
    await page.click("#m-week");
    await page.locator('.detail[data-id="201"] #f-week[open]').waitFor();
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("no countdown three hours or more ahead; a calm empty state when nothing is left", async () => {
  const early = await open({ now: new Date("2026-11-14T12:00:00+01:00") });
  try { assert.equal(await early.page.locator("#m-when .when-side span").textContent(), "vasárnapra érvényes"); }
  finally { await early.close(); }
  const ctx = await browser.newContext({ ...IPHONE, timezoneId: "Europe/Budapest" });
  try {
    const page = await ctx.newPage();
    await mockSupabase(page, { rpc: { public_data: () => church(), track: () => null } });
    await page.clock.setFixedTime(new Date("2026-11-14T22:00:00+01:00"));
    await page.goto(server.url + "/index.html");
    await page.locator("#m-empty").waitFor({ timeout: 15000 });
    assert.match(await page.locator("#m-empty").textContent(), /^Ma már nincs több ismert szentmise a közelben\./);
    assert.match(await page.locator("#m-day").textContent(), /^Szombat, november 14\./);
    assert.equal(await page.locator("#panel img").count(), 0);
    assert.equal(await page.locator("#m-name").count(), 0, "no church when nothing is left");
  } finally { await ctx.close(); }
});

test("red means only the next one", async () => {
  const { page, close } = await open();
  try {
    const r = await page.evaluate(() => {
      const probe = document.createElement("i"); probe.style.color = "var(--red)"; document.body.append(probe);
      const red = getComputedStyle(probe).color; probe.remove();
      const ink = getComputedStyle(document.body).color;
      // Every visible element that paints red itself: text whose parent is not red, a red fill, or a red border.
      const reds = [...document.querySelectorAll("#col *, #tabs *")].filter(e => e.checkVisibility()).filter(e => {
        const s = getComputedStyle(e), ps = getComputedStyle(e.parentElement);
        return (s.color === red && ps.color !== red) || s.backgroundColor === red || (s.borderTopColor === red && parseFloat(s.borderTopWidth) > 0);
      }).map(e => e.id || e.className || e.tagName);
      const c = s => getComputedStyle(document.querySelector(s));
      return { red, ink, reds, big: c("#m-when .big").color, name: c("#m-name").color, go: c("#m-dir").backgroundColor, tab: c('.tab[aria-pressed="true"]').color, row: c(".most .r-t").color };
    });
    assert.equal(r.red, "rgb(180, 35, 42)");
    assert.deepEqual(r.reds, ["now"], "only the next one's kind is red");
    for (const k of ["big", "name", "go", "tab", "row"]) assert.equal(r[k], r.ink, `${k} is ink`);
  } finally { await close(); }
});

test("tabs: Most · Térkép · Mentett, Most first", async () => {
  const { page, close } = await open();
  try {
    assert.deepEqual(await page.$$eval(".tab", els => els.map(e => [e.textContent.trim(), e.getAttribute("aria-pressed")])), [["Most", "true"], ["Térkép", "false"], ["Mentett", "false"]]);
  } finally { await close(); }
});

test("dark mode: the dark ground, light ink, photos unchanged", async () => {
  const { page, close } = await open({ colorScheme: "dark" });
  try {
    const r = await page.evaluate(() => ({ body: getComputedStyle(document.body).backgroundColor, col: getComputedStyle(document.querySelector("#col")).backgroundColor,
      ink: getComputedStyle(document.querySelector("#m-name")).color, filter: getComputedStyle(document.querySelector(".ph-img")).filter, red: getComputedStyle(document.querySelector("#m-when em")).color }));
    assert.deepEqual(r, { body: "rgb(14, 14, 14)", col: "rgb(14, 14, 14)", ink: "rgb(241, 241, 241)", filter: "none", red: "rgb(255, 90, 95)" });
  } finally { await close(); }
});

for (const view of ["iPhone 13", "1440x900"]) test(`no element uses a serif font (${view})`, async () => {
  const { page, close } = await open({ view: view === "1440x900" ? { viewport: { width: 1440, height: 900 } } : IPHONE });
  try {
    await page.click("#m-week"); await page.locator(".detail").waitFor();
    const bad = await page.evaluate(() => [...document.querySelectorAll("body, body *")].map(e => [e.tagName + (e.id ? "#" + e.id : ""), getComputedStyle(e).fontFamily])
      .filter(([, f]) => f.split(",").map(x => x.trim().replace(/"/g, "").toLowerCase()).some(x => x === "serif" || /garamond|georgia|times/.test(x))));
    assert.deepEqual(bad, []);
    assert.match(await page.evaluate(() => getComputedStyle(document.body).fontFamily), /^-apple-system, "SF Pro Text", Roboto, system-ui, sans-serif$/);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#d-next .big")).fontVariantNumeric), "tabular-nums");
  } finally { await close(); }
});

test("the liturgical week", async () => {
  const { page, close } = await open();
  try {
    const got = await page.evaluate(() => Object.fromEntries([
      [2026, 10, 14], [2026, 10, 29], [2026, 11, 7], [2026, 11, 25], [2026, 0, 12], [2026, 1, 18], [2026, 1, 22], [2026, 2, 29], [2026, 3, 5], [2026, 3, 12], [2026, 4, 25], [2026, 10, 22],
    ].map(([y, m, d]) => [`${y}-${m + 1}-${d}`, litWeek(new Date(y, m, d))])));
    assert.deepEqual(got, {
      "2026-11-14": "Évközi 32. hét", "2026-11-29": "Advent 1. hete", "2026-12-7": "Advent 2. hete", "2026-12-25": "Karácsonyi idő", "2026-1-12": "Évközi 1. hét",
      "2026-2-18": "Nagyböjt", "2026-2-22": "Nagyböjt 1. hete", "2026-3-29": "Nagyhét", "2026-4-5": "Húsvét nyolcada", "2026-4-12": "Húsvéti idő 2. hete",
      "2026-5-25": "Évközi 8. hét", "2026-11-22": "Évközi 34. hét",
    });
  } finally { await close(); }
});
