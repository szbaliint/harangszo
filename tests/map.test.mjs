// Task 3: map shell — search and chips on top, Legközelebb card, Térkép · Lista · Mentett tabs (demo mode, data.js).
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
  await page.clock.setFixedTime(NOW);
  await page.goto(`${server.url}/index.html`);
  await page.waitForSelector("#nearest .nh");
  return { page, errors, close: () => context.close() };
}
const fold = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
// The panel re-renders inside a view transition (Task 10), a moment after the click: wait for it to finish.
const settled = page => page.waitForFunction(() => !/\bvt-/.test(document.documentElement.className));
const cardNames = async page => { await settled(page); return page.$$eval("#panel .lcard .lc-name", els => els.map(e => e.textContent)); };

for (const view of Object.keys(VIEWS)) {
  test(`tabs (${view})`, async () => {
    const { page, errors, close } = await open(view);
    try {
      assert.deepEqual(await page.$$eval(".ui-tab", els => els.map(e => e.textContent.trim())), ["Térkép", "Lista", "Mentett"]);
      assert.equal(await page.locator("#filter-btn").count(), 0, "the round filter button is gone");
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  test(`search on top (${view})`, async () => {
    const { page, errors, close } = await open(view);
    try {
      await page.click('.ui-tab[data-tab="map"]');
      assert.ok(await page.locator("#q").isVisible(), "#q visible with the sheet closed");
      await page.fill("#q", "bazilika");
      await page.click('.ui-tab[data-tab="list"]');
      await page.waitForFunction(() => document.querySelectorAll("#panel .lcard").length > 0 && document.querySelector("#panel h2")?.textContent === "Találatok");
      const cards = await page.$$eval("#panel .lcard", els => els.map(e => e.textContent));
      assert.ok(cards.length >= 1);
      for (const c of cards) assert.ok(fold(c).includes("bazilika"), `card does not match: ${c}`);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  test(`chips filter (${view})`, async () => {
    const { page, errors, close } = await open(view);
    try {
      const chip = page.locator("#chips .ui-chip", { hasText: "Gyóntatás" });
      await chip.click();
      assert.equal(await page.locator("#chips .ui-chip", { hasText: "Gyóntatás" }).getAttribute("aria-pressed"), "true");
      await page.click('.ui-tab[data-tab="list"]');
      const cards = await page.$$eval("#panel .lcard", els => els.map(e => ({ name: e.querySelector(".lc-name").textContent, conf: !!e.querySelector(".ui-tag.t-conf"), tags: e.querySelectorAll(".ui-tag").length })));
      assert.ok(cards.length >= 3, `some churches confess today (${cards.length})`);
      for (const c of cards) {
        assert.ok(c.conf, `${c.name} has no confession tag`);
        assert.ok(c.tags <= 2, `${c.name} has ${c.tags} tags`);
      }
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  test(`filter sheet (${view})`, async () => {
    const { page, errors, close } = await open(view);
    try {
      await page.click("#chips .ui-chip.more");
      await page.waitForSelector("dialog#filters[open]");
      for (const id of ["#day", "#origin"]) assert.ok(await page.locator(`#filters ${id}`).isVisible(), `${id} in the sheet`);
      await page.locator("#filters .ui-chip", { hasText: "Esemény a héten" }).click();
      assert.equal(await page.locator("#chips .more .badge").textContent(), "1", "badge counts the hidden filter");
      await page.selectOption("#filters #day", "1");
      assert.equal(await page.locator("#chips .daychip").textContent(), "Holnap");
      assert.equal(await page.locator("#chips .ui-chip", { hasText: "Most nyitva" }).count(), 0, "Most nyitva only for today");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("dialog#filters").open);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  test(`Legközelebb (${view})`, async () => {
    const { page, errors, close } = await open(view);
    try {
      const rows = await page.$$eval("#nearest .nx", els => els.map(e => ({ t: e.querySelector(".tt").textContent, meta: e.querySelector("small").textContent })));
      assert.equal(rows.length, 2);
      for (const r of rows) {
        assert.match(r.t, /^\d{2}:\d{2}$/);
        assert.match(r.meta, /^(mise|rorate|gyónás) · /);
      }
      assert.match(rows[0].meta, /^mise · /, "first row is the nearest Mass");
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  test(`Mentett (${view})`, async () => {
    const { page, errors, close } = await open(view);
    try {
      await page.click('.ui-tab[data-tab="saved"]');
      assert.match(await page.locator("#panel .ui-empty").textContent(), /Még nincs mentett templom/);
      await page.click('.ui-tab[data-tab="list"]');
      const name = (await cardNames(page))[0];
      await page.locator("#panel .lcard").first().click();
      const heart = page.locator("#save-church");
      assert.equal(await heart.getAttribute("aria-pressed"), "false");
      await heart.click();
      assert.equal(await heart.getAttribute("aria-pressed"), "true");
      assert.equal(await heart.getAttribute("aria-label"), "Eltávolítás a kedvencek közül");

      await page.reload();
      await page.waitForSelector("#nearest .nh");
      await page.click('.ui-tab[data-tab="saved"]');
      assert.deepEqual(await cardNames(page), [name]);

      await page.locator("#panel .lcard").first().click();
      assert.equal(await page.locator("#save-church").getAttribute("aria-pressed"), "true");
      await page.click("#save-church");
      assert.equal(await page.locator("#save-church").getAttribute("aria-pressed"), "false");
      await page.click("#back");
      assert.deepEqual(await cardNames(page), []);
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
      await page.click('.ui-tab[data-tab="list"]');
      assert.ok((await cardNames(page)).length > 0, "list renders");
      await page.locator("#panel .lcard").first().click();
      await page.click("#save-church");
      assert.equal(await page.locator("#save-church").getAttribute("aria-pressed"), "true");
      await page.click('.ui-tab[data-tab="saved"]');
      assert.equal((await cardNames(page)).length, 1, "saved for this session");
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });
}

test("fitPadding counts the search and chip rows (iPhone 13)", async () => {
  const { page, errors, close } = await open("iPhone 13");
  try {
    const r = await page.evaluate(() => ({ top: fitPadding().top, chips: document.querySelector("#chips").getBoundingClientRect().bottom }));
    assert.ok(r.top >= r.chips, `fitPadding().top ${r.top} < #chips bottom ${r.chips}`);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("phone: the full sheet leaves the search and chips visible", async () => {
  const { page, close } = await open("iPhone 13");
  try {
    await page.click('.ui-tab[data-tab="list"]');
    await page.waitForTimeout(450);
    const r = await page.evaluate(() => ({ sheet: document.querySelector("#sheet").getBoundingClientRect().top, chips: document.querySelector("#chips").getBoundingClientRect().bottom }));
    assert.ok(r.sheet >= r.chips, `sheet top ${r.sheet} under the chips (${r.chips})`);
  } finally { await close(); }
});
