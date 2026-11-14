// The map app's shell (demo mode, data.js): Most · Térkép · Mentett, the search panel with its filters, the phone
// map with its search field and bottom panel, Mentett, blocked storage, fitPadding.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, devices } from "./helpers/playwright.mjs";
import { startServer } from "./helpers/server.mjs";

let server, browser;
before(async () => { server = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.stop(); });

const { defaultBrowserType: _, ...IPHONE } = devices["iPhone 13"];
const VIEWS = { "iPhone 13": IPHONE, "1440x900": { viewport: { width: 1440, height: 900 } } };
// A Monday morning in Budapest: confessions and Masses are still to come in the sample data.
const NOW = new Date("2026-11-09T06:30:00+01:00");

async function open(view, { init } = {}) {
  const context = await browser.newContext({ ...VIEWS[view], timezoneId: "Europe/Budapest" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  if (init) await page.addInitScript(init);
  await page.route(/commons\.wikimedia\.org/, r => r.abort());
  await page.clock.setFixedTime(NOW);
  await page.goto(`${server.url}/index.html`);
  await page.waitForSelector("#m-name");
  return { page, errors, close: () => context.close() };
}
const fold = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
// The column re-renders inside a view transition, a moment after the click: wait for it to finish.
const settled = page => page.waitForFunction(() => !/\bvt-/.test(document.documentElement.className));
const rowNames = async (page, scope = "#panel") => { await settled(page); return page.$$eval(`${scope} .row .r-name`, els => els.map(e => e.textContent)); };
async function openSearch(page) {
  await page.click("#m-search");
  await page.waitForSelector('#search[data-open="true"]');
}

for (const view of Object.keys(VIEWS)) {
  test(`tabs (${view})`, async () => {
    const { page, errors, close } = await open(view);
    try {
      assert.deepEqual(await page.$$eval(".tab", els => els.map(e => e.textContent.trim())), ["Most", "Térkép", "Mentett"]);
      assert.equal(await page.locator('.tab[aria-pressed="true"]').textContent(), "Most", "Most is home");
      assert.equal(await page.locator("#chips, #filters, #menu-btn").count(), 0, "no chip row, filter dialog or menu button");
      assert.match(await page.locator("#m-name").textContent(), /Mátyás/, "the nearest church with a Mass to come");
      assert.equal(await page.locator("#m-when .big").textContent(), "07:00");
      assert.match(await page.locator("#m-when").textContent(), /30 perc múlva/);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  test(`search panel (${view})`, async () => {
    const { page, errors, close } = await open(view);
    try {
      await openSearch(page);
      assert.ok(await page.evaluate(() => document.activeElement.id === "q"), "the field has focus");
      await page.fill("#q", "bazilika");
      await page.waitForFunction(() => document.querySelector("#s-results h2")?.textContent === "Találatok");
      const names = await rowNames(page, "#s-results");
      assert.ok(names.length >= 1);
      for (const n of await page.$$eval("#s-results .row", els => els.map(e => e.textContent))) assert.ok(fold(n).includes("bazilika"), `row does not match: ${n}`);
      await page.click("#s-results .row");
      await page.waitForSelector(".detail");
      assert.equal(await page.locator("#search").getAttribute("data-open"), "false", "choosing a church closes the search");
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  test(`kind filter (${view})`, async () => {
    const { page, errors, close } = await open(view);
    try {
      await openSearch(page);
      await page.click('#s-filters [data-kind="conf"]');
      assert.equal(await page.locator('#s-filters [data-kind="conf"]').getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator('#s-filters [data-kind=""]').getAttribute("aria-pressed"), "false");
      const rows = await page.$$eval("#s-results .row", els => els.map(e => ({ name: e.querySelector(".r-name").textContent, sub: e.querySelector("small").textContent, t: e.querySelector(".r-t").textContent })));
      assert.ok(rows.length >= 3, `some churches confess today (${rows.length})`);
      for (const r of rows) { assert.match(r.sub, /^gyónás · /, `${r.name}: ${r.sub}`); assert.match(r.t, /^\d{2}:\d{2}$/); }
      await page.click('#s-filters [data-kind=""]');
      assert.ok((await rowNames(page, "#s-results")).length > rows.length, "Mind shows every church again");
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  test(`more filters (${view})`, async () => {
    const { page, errors, close } = await open(view);
    try {
      await openSearch(page);
      await page.click("#s-more summary");
      for (const id of ["#day", "#origin"]) assert.ok(await page.locator(`#s-filters ${id}`).isVisible(), `${id} in the panel`);
      assert.equal(await page.locator('#s-filters .ui-toggle[data-f="open"]').count(), 1, "Most nyitva today");
      await page.locator('#s-filters .ui-toggle[data-f="ev"]').check();
      assert.match(await page.locator("#s-more summary .count").textContent(), /1 bekapcsolva/);
      await page.selectOption("#s-filters #day", "1");
      assert.match(await page.locator("#s-more summary .count").textContent(), /^Holnap/);
      assert.equal(await page.locator('#s-filters .ui-toggle[data-f="open"]').count(), 0, "Most nyitva only for today");
      assert.equal(await page.locator("#s-more").getAttribute("open"), "", "stays open across re-renders");
      await page.keyboard.press("Escape");
      await page.waitForSelector('#search[data-open="false"]', { state: "attached" });
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  test(`Mentett (${view})`, async () => {
    const { page, errors, close } = await open(view);
    try {
      await page.click('.tab[data-tab="saved"]');
      await settled(page);
      assert.match(await page.locator("#panel .ui-empty").textContent(), /Még nincs mentett templom/);
      await page.click('.tab[data-tab="most"]');
      await settled(page);
      const name = (await rowNames(page))[0];
      await page.locator("#panel .most .row").first().click();
      const heart = page.locator("#save-church");
      assert.equal(await heart.getAttribute("aria-pressed"), "false");
      await heart.click();
      assert.equal(await heart.getAttribute("aria-pressed"), "true");
      assert.equal(await heart.getAttribute("aria-label"), "Eltávolítás a kedvencek közül");

      await page.reload();
      await page.waitForSelector("#m-name");
      await page.click('.tab[data-tab="saved"]');
      assert.deepEqual(await rowNames(page), [name]);

      await page.locator("#panel .row").first().click();
      assert.equal(await page.locator("#save-church").getAttribute("aria-pressed"), "true");
      await page.click("#save-church");
      assert.equal(await page.locator("#save-church").getAttribute("aria-pressed"), "false");
      await page.click("#back");
      assert.deepEqual(await rowNames(page), []);
      assert.match(await page.locator("#panel .ui-empty").textContent(), /Még nincs mentett templom/);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  test(`storage blocked (${view})`, async () => {
    const { page, errors, close } = await open(view, {
      init: () => {
        const no = () => { throw new DOMException("blocked", "SecurityError"); };
        Storage.prototype.getItem = no; Storage.prototype.setItem = no; Storage.prototype.removeItem = no;
      },
    });
    try {
      assert.ok((await rowNames(page)).length > 0, "Most renders");
      await page.click("#m-save");
      assert.equal(await page.locator("#m-save").getAttribute("aria-pressed"), "true");
      await page.click('.tab[data-tab="saved"]');
      assert.equal((await rowNames(page)).length, 1, "saved for this session");
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });
}

test("Térkép (phone): the map with its search field and the bottom panel", async () => {
  const { page, errors, close } = await open("iPhone 13");
  try {
    assert.equal(await page.locator("#map-search").isVisible(), false, "the map's UI waits under Most");
    await page.click('.tab[data-tab="map"]');
    await settled(page);
    assert.ok(await page.locator("#map-search").isVisible());
    assert.equal(await page.locator("#col").isVisible(), false, "the column steps aside");
    assert.equal(await page.locator("#mapcard .mc-main .mid").textContent(), "07:00");
    assert.match(await page.locator("#mapcard .mc-main strong").textContent(), /Mátyás/);
    assert.ok(await page.locator("#mapcard .mc-row").isVisible(), "the next time after it");
    const c = await page.evaluate(() => ({ card: document.querySelector("#mapcard").getBoundingClientRect().bottom, tabs: document.querySelector("#tabs").getBoundingClientRect().top }));
    assert.ok(Math.abs(c.card - c.tabs) <= 1, "the panel sits on the tab bar");
    // Its search field opens the search panel; the tapped church's page opens from the panel.
    await page.click("#map-search");
    await page.waitForSelector('#search[data-open="true"]');
    await page.click("#search-done");
    await page.click("#mapcard .mc-main");
    await page.waitForSelector(".detail");
    await page.click("#back");
    await settled(page);
    assert.ok(await page.locator("#map-search").isVisible(), "back to the map");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("fitPadding counts the search field and the bottom panel (iPhone 13)", async () => {
  const { page, errors, close } = await open("iPhone 13");
  try {
    const r = await page.evaluate(() => ({ p: fitPadding(), top: document.querySelector("#map-search").getBoundingClientRect().bottom,
      bottom: innerHeight - document.querySelector("#mapcard").getBoundingClientRect().top }));
    assert.ok(r.top > 40 && r.p.top >= r.top, `fitPadding().top ${r.p.top} < search bottom ${r.top}`);
    assert.ok(r.bottom > 100 && r.p.bottom >= r.bottom, `fitPadding().bottom ${r.p.bottom} < ${r.bottom}`);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("desktop: a 420px column beside the map, tabs as a segmented row on top", async () => {
  const { page, errors, close } = await open("1440x900");
  try {
    const r = await page.evaluate(() => ({ col: document.querySelector("#col").getBoundingClientRect().toJSON(), map: document.querySelector("#map").getBoundingClientRect().toJSON(),
      tabs: document.querySelector("#tabs").getBoundingClientRect().toJSON() }));
    assert.equal(r.col.left, 0); assert.equal(r.col.width, 420);
    assert.equal(r.map.left, 420); assert.equal(r.map.right, 1440);
    assert.equal(r.tabs.top, 0); assert.ok(r.tabs.bottom <= r.col.top + 1, "tabs above the column");
    await page.click('.tab[data-tab="map"]');
    await settled(page);
    assert.ok(await page.locator("#col").isVisible(), "the column stays");
    assert.ok((await rowNames(page)).length > 5, "it lists the churches near the map");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});
