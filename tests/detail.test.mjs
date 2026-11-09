// Task 4: church detail — next time first, actions, 7-day strip, that day's times, folded sections (demo mode, data.js).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, devices } from "./helpers/playwright.mjs";
import { startServer } from "./helpers/server.mjs";

let server, browser;
before(async () => { server = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.stop(); });

const { defaultBrowserType: _, ...IPHONE } = devices["iPhone 13"];
const VIEWS = { "iPhone 13": IPHONE, "1440x900": { viewport: { width: 1440, height: 900 } } };
// A Monday morning in Budapest: Masses and confessions are still to come in the sample data.
const NOW = new Date("2026-11-09T06:30:00+01:00");
const LONG = "Budapest-Belvárosi Nagyboldogasszony Főplébánia-templom (Belvárosi templom)";
// Extra sample churches, appended to data.js: one with contact, notes, an event and an approximate location;
// one with no schedule at all.
const EXTRA = `
SAMPLE_CHURCHES.push({id:9001,name:"Próba Szent Anna-templom",city:"Budapest",addr:"Batthyány tér 7.",rite:"rk",lat:47.5065,lon:19.0385,
  hours:[H("08:00","18:00")],mass:[{d:ALL,t:"07:30"},{d:ALL,t:"18:00",n:"Diákmise"}],conf:[{d:WD,f:"17:00",u:"17:45"}],
  ev:[{date:"2026-11-15",t:"16:00",title:"Adventi koncert",n:"Ingyenes"}],
  web:"szentanna.example.hu",phone:"+36 1 201 3456",note:"Nyári szünet:\\nAugusztusban az esti mise elmarad.",approx:true});
SAMPLE_CHURCHES.push({id:9002,name:"Üres Szent Kereszt-kápolna",city:"Budapest",addr:"Fő utca 1.",rite:"rk",lat:47.503,lon:19.039,mass:[],conf:[],ev:[]});`;

async function open(view = "iPhone 13", { now = NOW, rename } = {}) {
  const context = await browser.newContext({ ...VIEWS[view], timezoneId: "Europe/Budapest" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/data.js", async route => {
    const res = await route.fetch();
    let body = await res.text() + EXTRA;
    if (rename) body = body.replace(`name:"${rename[0]}"`, `name:${JSON.stringify(rename[1])}`);
    await route.fulfill({ response: res, body });
  });
  await page.clock.setFixedTime(now);
  await page.goto(`${server.url}/index.html`);
  await page.waitForSelector("#nearest .nh");
  return { page, errors, close: () => context.close() };
}
async function openChurch(page, id) {
  await page.click('.ui-tab[data-tab="list"]');
  await page.click(`#panel .lcard[data-id="${id}"]`);
  await page.waitForSelector(`.detail[data-id="${id}"]`);
}
// Document order of the first element matching each selector (-1 when missing).
const order = (page, sels) => page.evaluate(sels => {
  const all = [...document.querySelectorAll(".detail *")];
  return sels.map(s => all.indexOf(document.querySelector(".detail " + s)));
}, sels);

for (const view of Object.keys(VIEWS)) {
  test(`order (${view})`, async () => {
    const { page, errors, close } = await open(view);
    try {
      await openChurch(page, 1);
      const sels = [".d-tags", "h2.d-name", ".d-where", ".ui-hero", ".d-actions", ".d-days", ".ui-glist#d-day", "#f-week", "#f-feasts"];
      const idx = await order(page, sels);
      sels.forEach((s, i) => assert.ok(idx[i] >= 0, `${s} is missing`));
      assert.deepEqual([...idx].sort((a, b) => a - b), idx, `out of order: ${sels.map((s, i) => s + "@" + idx[i]).join(" ")}`);
      assert.equal(await page.locator(".d-bar #save-church").count(), 1, "♡ in the top bar");
      assert.equal(await page.locator(".d-bar #share").getAttribute("aria-label"), "Megosztás");
      assert.equal(await page.locator(".d-bar #back").getAttribute("aria-label"), "Vissza");
      assert.match(await page.locator(".ui-hero small").textContent(), /^Következő mise$/);
      assert.equal(await page.locator(".ui-hero .t").textContent(), "08:00");
      assert.equal(await page.locator(".ui-hero .in").textContent(), "1 ó 30 p múlva");
      assert.deepEqual(await page.$$eval(".d-actions .d-act", els => els.map(e => e.textContent.trim())), ["Útvonal", "Javítás"], "no phone or web: those tiles collapse");
      assert.equal(await page.locator(".d-days button").count(), 7);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });
}

test("order with every section", async () => {
  const { page, errors, close } = await open();
  try {
    await openChurch(page, 9001);
    const sels = [".d-tags", "h2.d-name", ".d-where", ".d-approx", ".ui-hero", ".d-actions", ".d-days", ".ui-glist#d-day", "#f-week", "#f-events", "#f-note"];
    const idx = await order(page, sels);
    sels.forEach((s, i) => assert.ok(idx[i] >= 0, `${s} is missing`));
    assert.deepEqual([...idx].sort((a, b) => a - b), idx);
    assert.deepEqual(await page.$$eval(".d-actions .d-act", els => els.map(e => e.textContent.trim())), ["Útvonal", "Hívás", "Weboldal", "Javítás"]);
    assert.equal(await page.locator(".d-act", { hasText: "Hívás" }).getAttribute("href"), "tel:+3612013456");
    assert.equal(await page.locator(".d-act", { hasText: "Weboldal" }).getAttribute("href"), "https://szentanna.example.hu");
    assert.equal(await page.locator("#f-week .count").textContent(), "3");
    assert.equal(await page.locator("#f-events .count").textContent(), "1");
    assert.equal(await page.locator("#f-note .count").count(), 0, "the note has no count");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("folds closed", async () => {
  const { page, errors, close } = await open();
  try {
    await openChurch(page, 1);
    const folds = await page.$$eval(".detail .ui-fold", els => els.map(e => ({ id: e.id, open: e.hasAttribute("open") })));
    assert.ok(folds.length >= 2);
    for (const f of folds) assert.equal(f.open, false, `${f.id} starts open`);
    assert.equal(await page.locator("#f-week table").isVisible(), false);
    await page.click("#f-week summary");
    assert.equal(await page.locator("#f-week").getAttribute("open"), "");
    assert.ok(await page.locator("#f-week .week table").isVisible(), "the week table shows");
    // The minute timer re-renders the detail: the open fold stays open.
    await page.evaluate(() => render());
    assert.equal(await page.locator("#f-week").getAttribute("open"), "");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("day strip", async () => {
  const { page, errors, close } = await open();
  try {
    await openChurch(page, 1);
    const days = page.locator(".d-days button");
    assert.equal(await days.nth(0).getAttribute("aria-pressed"), "true");
    const before = await page.locator("#d-day").innerHTML();
    await days.nth(1).click();
    assert.equal(await page.locator(".d-days button").nth(1).getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".d-days button").nth(0).getAttribute("aria-pressed"), "false");
    assert.equal(await page.locator("#d-day").getAttribute("aria-label"), "Holnap");
    assert.match(await page.locator(".ui-hero small").textContent(), /^Következő mise · kedd$/);
    assert.equal(await page.locator(".ui-hero .in").count(), 0, "no countdown for another day");
    assert.equal(await page.locator("#chips .daychip").textContent(), "Holnap", "same day as the filter");
    // Monday and Tuesday share their times at the basilica; Sunday does not.
    await page.locator(".d-days button").nth(6).click();
    assert.equal(await page.locator(".d-days button").nth(6).getAttribute("aria-pressed"), "true");
    assert.notEqual(await page.locator("#d-day").innerHTML(), before, "the day list changed");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("past faded", async () => {
  const { page, errors, close } = await open("iPhone 13", { now: new Date("2026-11-09T12:00:00+01:00") });
  try {
    await openChurch(page, 2);
    const rows = await page.$$eval("#d-day .d-row", els => els.map(e => ({ t: e.querySelector(".d-t").textContent, past: e.classList.contains("past") })));
    const seven = rows.find(r => r.t === "07:00"), six = rows.find(r => r.t === "18:00");
    assert.ok(seven && seven.past, "07:00 is past");
    assert.ok(six && !six.past, "18:00 is still to come");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("Javítás sheet", async () => {
  const { page, errors, close } = await open();
  try {
    await openChurch(page, 1);
    await page.locator(".d-act", { hasText: "Javítás" }).click();
    await page.waitForSelector("dialog#suggest[open]");
    for (const id of ["#s-type", "#s-text", "#s-send"]) assert.ok(await page.locator(`#suggest ${id}`).isVisible(), `${id} visible`);
    await page.click("#s-send");
    assert.match(await page.locator("#s-status").textContent(), /Írj legalább pár szót/);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("dialog#suggest").open);
    assert.equal(await page.locator(".detail").count(), 1, "Escape closes only the sheet");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("share copies the link without a share sheet", async () => {
  const { page, errors, close } = await open();
  try {
    await page.evaluate(() => {
      Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
      window.__copied = null;
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async t => { window.__copied = t; } }, configurable: true });
    });
    await openChurch(page, 1);
    await page.click("#share");
    await page.waitForSelector("#toast.on");
    assert.equal(await page.locator("#toast").textContent(), "Link másolva");
    assert.match(await page.evaluate(() => window.__copied), /\/index\.html#t=1$/);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("long name", async () => {
  const { page, errors, close } = await open("iPhone 13", { rename: ["Szent István-bazilika", LONG] });
  try {
    await openChurch(page, 1);
    const r = await page.evaluate(() => {
      const box = s => document.querySelector(s).getBoundingClientRect();
      const h = document.querySelector("h2.d-name");
      return { sw: h.scrollWidth, cw: h.clientWidth, name: box("h2.d-name"), acts: box(".d-actions"), bar: box(".d-bar"), panel: box("#panel"), text: h.textContent };
    });
    assert.equal(r.text, LONG);
    assert.ok(r.sw <= r.cw, `name overflows: ${r.sw} > ${r.cw}`);
    assert.ok(r.name.bottom <= r.acts.top, "name does not overlap the actions");
    assert.ok(r.name.top >= r.bar.bottom, "name does not run under the top bar");
    assert.ok(r.name.right <= r.panel.right, "name stays inside the panel");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("no schedule", async () => {
  const { page, errors, close } = await open();
  try {
    await openChurch(page, 9002);
    assert.equal(await page.locator(".detail .ui-hero").count(), 0, "no hero");
    assert.equal(await page.locator(".detail .ui-fold").count(), 0, "no folds");
    assert.equal(await page.locator(".detail .d-days").count(), 0, "no empty day strip");
    assert.match(await page.locator(".detail .ui-empty").textContent(), /^\s*Ehhez a templomhoz még nincs feltöltött időpont/);
    assert.ok(await page.locator(".d-act", { hasText: "Javítás" }).isVisible(), "Javítás stays");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("nothing more today", async () => {
  const { page, errors, close } = await open("iPhone 13", { now: new Date("2026-11-09T21:00:00+01:00") });
  try {
    await openChurch(page, 1);
    assert.equal(await page.locator(".detail .ui-hero").count(), 0);
    assert.equal(await page.locator(".detail .d-nomore").textContent(), "Ma már nincs több alkalom");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});
