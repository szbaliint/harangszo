// Motion: a church page slides in from the right and leaves along the same path (280ms, spring-like ease); tabs
// cross-fade (150ms); the search panel slides up and back down; under reduced motion everything is a 150ms
// cross-fade with no movement (demo mode).
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
  await page.route(/commons\.wikimedia\.org/, r => r.abort());
  await page.clock.setFixedTime(NOW);
  await page.goto(`${server.url}/index.html`);
  await page.waitForSelector("#m-name");
  return { page, errors, close: () => context.close() };
}
// Animations on the column: its view-transition pseudo-elements, or the fallback keyframes on #col itself.
const colAnims = page => page.evaluate(() => document.getAnimations()
  .filter(a => a.playState !== "finished" && (/\(col\)/.test(a.effect?.pseudoElement || "") || a.effect?.target?.id === "col"))
  .map(a => ({ name: a.animationName || a.id, pseudo: a.effect.pseudoElement || "", duration: a.effect.getTiming().duration, easing: a.effect.getTiming().easing,
    props: [...new Set(a.effect.getKeyframes().flatMap(k => Object.keys(k).filter(p => !["offset", "easing", "composite", "computedOffset"].includes(p))))] })));
const waitColAnim = page => page.waitForFunction(() => document.getAnimations()
  .some(a => a.playState !== "finished" && (/\(col\)/.test(a.effect?.pseudoElement || "") || a.effect?.target?.id === "col")), null, { timeout: 500, polling: "raf" });
const settle = page => page.waitForFunction(() => !document.getAnimations().some(a => a.playState === "running") && !/\bvt-/.test(document.documentElement.className), null, { timeout: 3000 });

for (const view of Object.keys(VIEWS)) {
  test(`a church page slides in, then leaves along the same path (${view})`, async () => {
    const { page, errors, close } = await open(view);
    try {
      await settle(page);
      await page.locator("#panel .most .row").first().click();
      await waitColAnim(page);
      const open_ = await colAnims(page);
      console.log(`  open (${view}):`, JSON.stringify(open_));
      assert.ok(open_.length > 0, "no animation on the church page");
      for (const a of open_) { assert.equal(a.duration, 280); assert.ok(a.props.includes("transform"), "it moves"); }
      await page.waitForFunction(() => document.querySelector("#panel .detail") && !document.getAnimations().some(a => a.playState === "running"
        && (/\(col\)/.test(a.effect?.pseudoElement || "") || a.effect?.target?.id === "col")), null, { timeout: 3000, polling: "raf" });
      await settle(page);
      await page.click("#back");
      await waitColAnim(page);
      const back = await colAnims(page);
      console.log(`  back (${view}):`, JSON.stringify(back));
      assert.ok(back.length > 0 && back.every(a => a.duration === 280 && a.props.includes("transform")), "back is not a 280ms slide");
      assert.ok(back.some(a => a.pseudo.includes("old")), "the church page itself leaves");
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  test(`tab switches cross-fade (${view})`, async () => {
    const { page, errors, close } = await open(view);
    try {
      await settle(page);
      await page.click('.tab[data-tab="saved"]');
      await waitColAnim(page);
      const tab = await colAnims(page);
      console.log(`  tab (${view}):`, JSON.stringify(tab));
      assert.ok(tab.length > 0 && tab.every(a => a.duration === 150 && a.props.join() === "opacity"), "tab switch is not a 150ms fade");
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  test(`reduced motion: only 150ms cross-fades, nothing moves (${view})`, async () => {
    const { page, errors, close } = await open(view, "reduce");
    try {
      await settle(page);
      await page.locator("#panel .most .row").first().click();
      await waitColAnim(page);
      const anims = await colAnims(page);
      assert.ok(anims.length > 0, "a cross-fade");
      for (const a of anims) { assert.equal(a.duration, 150); assert.deepEqual(a.props, ["opacity"]); }
      await settle(page);
      assert.ok(await page.locator("#panel .detail").isVisible());
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#col")).opacity), "1");
      // The search panel fades instead of sliding.
      await page.click("#back"); await settle(page);
      await page.click("#m-search");
      const s = await page.evaluate(() => { const cs = getComputedStyle(document.querySelector("#search")); return { t: cs.transform, prop: cs.transitionProperty }; });
      assert.equal(s.t, "none"); assert.match(s.prop, /opacity/); assert.doesNotMatch(s.prop, /transform/);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });
}

test("the search panel slides up and back down the same way (iPhone 13)", async () => {
  const { page, errors, close } = await open("iPhone 13");
  try {
    const cs = () => page.evaluate(() => { const s = getComputedStyle(document.querySelector("#search")); return { prop: s.transitionProperty, dur: s.transitionDuration, ease: s.transitionTimingFunction }; });
    const closed = await cs();
    await page.click("#m-search");
    const opened = await cs();
    for (const t of [closed, opened]) { assert.match(t.prop, /^transform/); assert.match(t.dur, /^0\.28s/); assert.match(t.ease, /cubic-bezier\(0\.2, 0\.8, 0\.2, 1\)/); }
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#search")).transform === "none" || getComputedStyle(document.querySelector("#search")).transform === "matrix(1, 0, 0, 1, 0, 0)");
    await page.click("#search-done");
    await page.waitForFunction(() => document.querySelector("#search").getBoundingClientRect().top >= innerHeight - 1, null, { timeout: 2000 });
    assert.deepEqual(errors, []);
  } finally { await close(); }
});
