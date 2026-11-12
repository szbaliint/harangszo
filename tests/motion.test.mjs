// Task 10: motion — the detail slides in, back and tab switches fade; nothing animates under reduced motion (demo mode).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, devices } from "./helpers/playwright.mjs";
import { startServer } from "./helpers/server.mjs";

let server, browser;
before(async () => { server = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.stop(); });

const { defaultBrowserType: _, ...IPHONE } = devices["iPhone 13"];
const VIEWS = { "iPhone 13": IPHONE, "1440x900": { viewport: { width: 1440, height: 900 } } };
const NOW = new Date("2026-11-09T06:30:00+01:00");

async function open(view, reducedMotion = "no-preference") {
  const context = await browser.newContext({ ...VIEWS[view], timezoneId: "Europe/Budapest", reducedMotion });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.clock.setFixedTime(NOW);
  await page.goto(`${server.url}/index.html`);
  await page.waitForSelector("#nearest .nh");
  return { page, errors, close: () => context.close() };
}
// Animations on the panel: its view-transition pseudo-elements, or the fallback keyframes on #panel itself.
const panelAnims = page => page.evaluate(() => document.getAnimations()
  .filter(a => a.playState !== "finished" && (/\(panel\)/.test(a.effect?.pseudoElement || "") || a.effect?.target?.id === "panel"))
  .map(a => ({ name: a.animationName || a.id, pseudo: a.effect.pseudoElement || "", duration: a.effect.getTiming().duration })));
const waitPanelAnim = page => page.waitForFunction(() => document.getAnimations()
  .some(a => a.playState !== "finished" && (/\(panel\)/.test(a.effect?.pseudoElement || "") || a.effect?.target?.id === "panel")), null, { timeout: 300, polling: "raf" });
const settle = page => page.waitForFunction(() => !document.getAnimations().some(a => a.playState === "running"), null, { timeout: 2000 });

for (const view of Object.keys(VIEWS)) {
  test(`opening a church animates the detail, then it is fully visible (${view})`, async () => {
    const { page, errors, close } = await open(view);
    try {
      await page.click('.ui-tab[data-tab="list"]');
      await page.waitForSelector("#panel .lcard");
      await settle(page);
      await page.locator("#panel .lcard").first().click();
      await waitPanelAnim(page);
      const anims = await panelAnims(page);
      console.log(`  open (${view}):`, JSON.stringify(anims));
      assert.ok(anims.length > 0, "no animation on the detail");
      for (const a of anims) assert.ok(a.duration >= 180 && a.duration <= 280, `duration ${a.duration}`);
      await page.waitForFunction(() => document.querySelector("#panel .detail") && getComputedStyle(document.querySelector("#panel")).opacity === "1"
        && !document.getAnimations().some(a => a.playState === "running" && (/\(panel\)/.test(a.effect?.pseudoElement || "") || a.effect?.target?.id === "panel")),
        // The animation's own length is checked above (180–280 ms); this only checks the detail ends fully visible.
        // A wall-clock budget from the click also counted the test's own steps and failed under a busy full run.
        null, { timeout: 2000, polling: "raf" });
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  test(`back and tab switches fade the panel (${view})`, async () => {
    const { page, errors, close } = await open(view);
    try {
      await page.click('.ui-tab[data-tab="list"]');
      await page.waitForSelector("#panel .lcard");
      await settle(page);
      await page.locator("#panel .lcard").first().click();
      await page.waitForSelector("#panel .detail");
      await settle(page);
      await page.click("#back");
      await waitPanelAnim(page);
      const back = await panelAnims(page);
      console.log(`  back (${view}):`, JSON.stringify(back));
      assert.ok(back.length > 0 && back.every(a => a.duration === 200), "back is not a 200ms animation");
      await settle(page);
      await page.click('.ui-tab[data-tab="saved"]');
      await waitPanelAnim(page);
      const tab = await panelAnims(page);
      console.log(`  tab (${view}):`, JSON.stringify(tab));
      assert.ok(tab.length > 0 && tab.every(a => a.duration === 180), "tab switch is not a 180ms fade");
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  test(`reduced motion: nothing animates, the detail swaps in at once (${view})`, async () => {
    const { page, errors, close } = await open(view, "reduce");
    try {
      await page.click('.ui-tab[data-tab="list"]');
      assert.equal(await page.evaluate(() => document.getAnimations().length), 0, "tab switch animated");
      await page.locator("#panel .lcard").first().click();
      const r = await page.evaluate(() => ({ n: document.getAnimations().length, detail: !!document.querySelector("#panel .detail"), op: getComputedStyle(document.querySelector("#panel")).opacity }));
      assert.equal(r.n, 0, "an animation ran under reduced motion");
      assert.ok(r.detail, "the detail is not there right after the click");
      assert.equal(r.op, "1");
      await page.click("#back");
      assert.equal(await page.evaluate(() => document.getAnimations().length + (document.querySelector("#panel .detail") ? 1 : 0)), 0);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });
}
