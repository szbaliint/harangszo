// The app's shell (demo mode, data.js): Indulások · Térkép · Keresés · Mentett, the Keresés tab with its field, day and
// filters, Mentett, blocked storage, the phone map with its search field and the mini pass, fitPadding, the desktop layout.
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
  await page.waitForSelector(".pass");
  return { page, errors, close: () => context.close() };
}
const fold = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
// The column re-renders inside a view transition, a moment after the click: wait for it to finish.
const settled = page => page.waitForFunction(() => !/\bvt-/.test(document.documentElement.className));
const rowNames = async (page, scope = "#panel") => { await settled(page); return page.$$eval(`${scope} .brow .b-name`, els => els.map(e => e.textContent)); };
async function openSearch(page) {
  await page.click('.tab[data-tab="list"]');
  await page.waitForSelector("#q");
  await settled(page);
}

for (const view of Object.keys(VIEWS)) {
  test(`tabs (${view})`, async () => {
    const { page, errors, close } = await open(view);
    try {
      assert.deepEqual(await page.$$eval(".tab", els => els.map(e => e.textContent.trim())), ["Indulások", "Térkép", "Keresés", "Mentett"]);
      assert.equal(await page.locator('.tab[aria-pressed="true"]').textContent(), "Indulások", "Indulások is home");
      assert.equal(await page.locator("#search, #near, #m-name").count(), 0, "no search panel, no Közel most panel, no Most");
      assert.match(await page.locator("#i-name").textContent(), /Mátyás/, "the Mass to leave for now");
      assert.equal(await page.locator("#i-time").textContent(), "07:00");
      assert.ok((await rowNames(page)).length >= 5, "the board below it");
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  test(`Keresés (${view})`, async () => {
    const { page, errors, close } = await open(view);
    try {
      await openSearch(page);
      assert.ok(await page.evaluate(() => document.activeElement.id === "q"), "the field has focus");
      assert.equal(await page.locator(".bhead h1").textContent(), "Keresés");
      await page.fill("#q", "bazilika");
      await page.waitForFunction(() => document.querySelector("#s-results h2")?.textContent === "Találatok");
      const names = await rowNames(page, "#s-results");
      assert.ok(names.length >= 1);
      for (const n of await page.$$eval("#s-results .brow", els => els.map(e => e.textContent))) assert.ok(fold(n).includes("bazilika"), `row does not match: ${n}`);
      await page.click("#s-results .brow");
      await page.waitForSelector(".detail");
      await settled(page);
      await page.click("#back");
      await page.waitForSelector("#q");
      assert.equal(await page.inputValue("#q"), "bazilika", "back on Keresés, the word kept");
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
      const rows = await page.$$eval("#s-results .brow", els => els.map(e => ({ name: e.querySelector(".b-name").textContent, sub: e.querySelector(".b-sub").textContent, t: e.querySelector(".b-t").textContent })));
      assert.ok(rows.length >= 3, `some churches confess today (${rows.length})`);
      for (const r of rows) { assert.match(r.sub, /^gyónás · /, `${r.name}: ${r.sub}`); assert.match(r.t, /^\d{2}:\d{2}$/); }
      await page.click('#s-filters [data-kind=""]');
      assert.ok((await rowNames(page, "#s-results")).length > rows.length, "Mind shows every church again");
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  test(`day and more filters (${view})`, async () => {
    const { page, errors, close } = await open(view);
    try {
      await openSearch(page);
      assert.ok(await page.locator("#s-filters #day").isVisible(), "the day is always at hand");
      await page.click("#s-more summary");
      assert.ok(await page.locator("#s-filters #origin").isVisible());
      assert.equal(await page.locator('#s-filters .ui-toggle[data-f="open"]').count(), 1, "Most nyitva today");
      await page.locator('#s-filters .ui-toggle[data-f="ev"]').check();
      assert.equal(await page.locator("#s-more summary .count").textContent(), "1");
      await page.selectOption("#s-filters #day", "1");
      assert.match(await page.locator("#s-results .summary").textContent(), /helyen gyóntatnak aznap/);
      assert.equal(await page.locator('#s-filters .ui-toggle[data-f="open"]').count(), 0, "Most nyitva only for today");
      assert.equal(await page.locator("#s-more").getAttribute("open"), "", "stays open across re-renders");
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  test(`Mentett (${view})`, async () => {
    const { page, errors, close } = await open(view);
    try {
      await page.click('.tab[data-tab="saved"]');
      await settled(page);
      assert.equal(await page.locator("#panel .board-empty h2").textContent(), "Még nincs mentett templom");
      await page.click('.tab[data-tab="most"]');
      await settled(page);
      const name = (await rowNames(page))[0];
      await page.locator("#i-rows .brow").first().click();
      const save = page.locator("#save-church");
      assert.equal(await save.getAttribute("aria-pressed"), "false");
      assert.equal((await save.textContent()).trim(), "Mentés");
      await save.click();
      assert.equal(await save.getAttribute("aria-pressed"), "true");
      assert.equal(await save.getAttribute("title"), "Eltávolítás a mentettek közül");

      await page.reload();
      await page.waitForSelector(".pass");
      await page.click('.tab[data-tab="saved"]');
      assert.deepEqual(await rowNames(page), [name]);

      await page.locator("#panel .brow").first().click();
      assert.equal(await page.locator("#save-church").getAttribute("aria-pressed"), "true");
      await page.click("#save-church");
      assert.equal(await page.locator("#save-church").getAttribute("aria-pressed"), "false");
      await page.click("#back");
      assert.deepEqual(await rowNames(page), []);
      assert.equal(await page.locator("#panel .board-empty h2").textContent(), "Még nincs mentett templom");
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
      assert.ok((await rowNames(page)).length > 0, "Indulások renders");
      await page.locator(".pass-open").click();
      await page.click("#save-church");
      assert.equal(await page.locator("#save-church").getAttribute("aria-pressed"), "true");
      await page.click('.tab[data-tab="saved"]');
      assert.equal((await rowNames(page)).length, 1, "saved for this session");
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });
}

test("Térkép (phone): the map with its search field and the mini pass", async () => {
  const { page, errors, close } = await open("iPhone 13");
  try {
    assert.equal(await page.locator("#map-search").isVisible(), false, "the map's UI waits under Indulások");
    await page.click('.tab[data-tab="map"]');
    await settled(page);
    assert.ok(await page.locator("#map-search").isVisible());
    assert.equal(await page.locator("#col").isVisible(), false, "the column steps aside");
    assert.equal(await page.locator("#mapcard .mc-main .mid").textContent(), "07:00");
    assert.match(await page.locator("#mapcard .mc-main strong").textContent(), /Mátyás/);
    assert.equal(await page.locator("#mapcard").getAttribute("class"), "mapcard go", "the pass, in amber");
    assert.ok(await page.locator("#mapcard .mc-row").isVisible(), "the next time after it");
    const c = await page.evaluate(() => ({ card: document.querySelector("#mapcard").getBoundingClientRect(), tabs: document.querySelector("#tabs").getBoundingClientRect().top }));
    assert.ok(c.tabs - c.card.bottom >= 0 && c.tabs - c.card.bottom <= 16, `the mini pass floats just above the tab bar (${c.tabs - c.card.bottom}px)`);
    assert.ok(c.card.left >= 8 && c.card.left <= 16, "with a margin, like a card");
    // Its search field opens Keresés; the church's page opens from the mini pass.
    await page.click("#map-search");
    await page.waitForSelector("#q");
    assert.ok(await page.evaluate(() => document.activeElement.id === "q"));
    await page.click('.tab[data-tab="map"]');
    await settled(page);
    await page.click("#mapcard .mc-main");
    await page.waitForSelector(".detail");
    await settled(page);
    await page.click("#back");
    await settled(page);
    assert.ok(await page.locator("#map-search").isVisible(), "back to the map");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("fitPadding counts the search field and the mini pass (iPhone 13)", async () => {
  const { page, errors, close } = await open("iPhone 13");
  try {
    const r = await page.evaluate(() => ({ p: fitPadding(), top: document.querySelector("#map-search").getBoundingClientRect().bottom,
      bottom: innerHeight - document.querySelector("#mapcard").getBoundingClientRect().top }));
    assert.ok(r.top > 40 && r.p.top >= r.top, `fitPadding().top ${r.p.top} < search bottom ${r.top}`);
    assert.ok(r.bottom > 100 && r.p.bottom >= r.bottom, `fitPadding().bottom ${r.p.bottom} < ${r.bottom}`);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("desktop: a 420px column beside the map, the tabs in its navy top bar", async () => {
  const { page, errors, close } = await open("1440x900");
  try {
    const r = await page.evaluate(() => ({ col: document.querySelector("#col").getBoundingClientRect().toJSON(), map: document.querySelector("#map").getBoundingClientRect().toJSON(),
      tabs: document.querySelector("#tabs").getBoundingClientRect().toJSON(), bg: getComputedStyle(document.querySelector("#tabs")).backgroundColor }));
    assert.equal(r.col.left, 0); assert.equal(r.col.width, 420);
    assert.equal(r.map.left, 420); assert.equal(r.map.right, 1440);
    assert.equal(r.tabs.top, 0); assert.equal(r.tabs.width, 420); assert.ok(r.tabs.bottom <= r.col.top + 1, "tabs above the column");
    assert.equal(r.bg, "rgb(19, 35, 63)");
    await page.click('.tab[data-tab="map"]');
    await settled(page);
    assert.ok(await page.locator("#col").isVisible(), "the column stays");
    assert.ok((await rowNames(page)).length > 5, "it lists the churches near the map");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});
