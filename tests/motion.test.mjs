// Motion: a church page comes in from the right and leaves along the same path (350ms on a critically damped spring);
// tabs cross-fade (150ms); a press answers on pointer-down; under reduced motion everything is a 150ms cross-fade with
// no movement (demo mode). The board's FLIP rerank is in indulasok.test.mjs.
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
  await page.waitForSelector(".pass");
  return { page, errors, close: () => context.close() };
}
// Animations on the column: its view-transition pseudo-elements, or the fallback keyframes on #col itself.
const colAnims = page => page.evaluate(() => document.getAnimations()
  .filter(a => a.playState !== "finished" && (/\(col\)/.test(a.effect?.pseudoElement || "") || a.effect?.target?.id === "col"))
  .map(a => ({ name: a.animationName || a.id, pseudo: a.effect.pseudoElement || "", duration: a.effect.getTiming().duration, easing: a.effect.getKeyframes()[0]?.easing || a.effect.getTiming().easing,
    props: [...new Set(a.effect.getKeyframes().flatMap(k => Object.keys(k).filter(p => !["offset", "easing", "composite", "computedOffset"].includes(p))))] })));
const waitColAnim = page => page.waitForFunction(() => document.getAnimations()
  .some(a => a.playState !== "finished" && (/\(col\)/.test(a.effect?.pseudoElement || "") || a.effect?.target?.id === "col")), null, { timeout: 500, polling: "raf" });
const settle = page => page.waitForFunction(() => !document.getAnimations().some(a => a.playState === "running") && !/\bvt-/.test(document.documentElement.className), null, { timeout: 3000 });

for (const view of Object.keys(VIEWS)) {
  test(`a church page slides in, then leaves along the same path (${view})`, async () => {
    const { page, errors, close } = await open(view);
    try {
      await settle(page);
      await page.locator("#i-rows .brow").first().click();
      await waitColAnim(page);
      const open_ = await colAnims(page);
      console.log(`  open (${view}):`, JSON.stringify(open_));
      assert.ok(open_.length > 0, "no animation on the church page");
      for (const a of open_) { assert.equal(a.duration, 350); assert.ok(a.props.includes("transform"), "it moves"); assert.match(a.easing, /^linear\(0/, "on the spring"); }
      await page.waitForFunction(() => document.querySelector("#panel .detail") && !document.getAnimations().some(a => a.playState === "running"
        && (/\(col\)/.test(a.effect?.pseudoElement || "") || a.effect?.target?.id === "col")), null, { timeout: 3000, polling: "raf" });
      await settle(page);
      await page.click("#back");
      await waitColAnim(page);
      const back = await colAnims(page);
      console.log(`  back (${view}):`, JSON.stringify(back));
      assert.ok(back.length > 0 && back.every(a => a.duration === 350 && a.props.includes("transform")), "back is not a 350ms slide");
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
      await page.locator("#i-rows .brow").first().click();
      await waitColAnim(page);
      const anims = await colAnims(page);
      assert.ok(anims.length > 0, "a cross-fade");
      for (const a of anims) { assert.equal(a.duration, 150); assert.deepEqual(a.props, ["opacity"]); }
      await settle(page);
      assert.ok(await page.locator("#panel .detail").isVisible());
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#col")).opacity), "1");
      // A press does not shrink anything.
      await page.click("#back"); await settle(page);
      assert.equal(await page.locator(".pass").evaluate(e => getComputedStyle(e).transitionDuration), "0s");
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });
}

test("press feedback answers on pointer-down: the pass and a board row (iPhone 13)", async () => {
  const { page, errors, close } = await open("iPhone 13");
  try {
    await settle(page);
    const pressed = async (sel, read) => {
      const box = await page.locator(sel).first().boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 20));
      await page.mouse.down();
      await page.waitForTimeout(120);
      const v = await page.evaluate(read);
      await page.mouse.up();
      return v;
    };
    const pass = await pressed(".pass-open", () => getComputedStyle(document.querySelector(".pass")).transform);
    assert.match(pass, /^matrix\(0\.98/, `the pass gives under the finger (${pass})`);
    await settle(page);
    await page.locator('.tab[data-tab="most"]').click(); await settle(page);
    const row = await pressed("#i-rows .brow", () => getComputedStyle(document.querySelector("#i-rows li")).backgroundColor);
    assert.notEqual(row, "rgba(0, 0, 0, 0)", "the row darkens at once");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

// Small arrivals: a new pass comes up into its place (not the minute's status update); a tapped day's times come in
// from the side of travel; folds glide open and shut where the browser can animate to "auto".
const arrivals = (page, run) => page.evaluate(run => {
  new Function(run)();
  return document.getAnimations().filter(a => a.id === "arrive").map(a => ({ on: a.effect.target.id || a.effect.target.className, duration: a.effect.getTiming().duration,
    easing: a.effect.getTiming().easing, from: (({ opacity, transform }) => ({ opacity, transform }))(a.effect.getKeyframes()[0]) }));
}, run);
for (const reduced of [false, true]) {
  test(`a new pass card comes up into its place, the minute update does not move it${reduced ? " (reduced motion)" : ""}`, async () => {
    const { page, errors, close } = await open("iPhone 13", reduced ? "reduce" : "no-preference");
    try {
      await settle(page);
      assert.deepEqual(await arrivals(page, "render()"), [], "the same pass: no movement");
      const a = await arrivals(page, 'document.querySelector("#i-pass").dataset.sig = "stale"; render()');
      assert.deepEqual(a, [reduced ? { on: "pass", duration: 150, easing: "linear", from: { opacity: "0", transform: undefined } }
        : { on: "pass", duration: 220, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", from: { opacity: "0", transform: "translateY(8px)" } }]);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  test(`church page: a tapped day's times slide in from the side of travel${reduced ? " (reduced motion)" : ""}`, async () => {
    const { page, errors, close } = await open("iPhone 13", reduced ? "reduce" : "no-preference");
    try {
      await settle(page);
      await page.locator("#i-rows .brow").first().click();
      await page.locator(".d-days button").nth(2).waitFor(); await settle(page);
      const fwd = await arrivals(page, 'document.querySelectorAll(".d-days button")[2].click()');
      assert.equal(await page.locator(".d-days button").nth(2).getAttribute("aria-pressed"), "true", "the highlight moves at once");
      await settle(page);
      const bwd = await arrivals(page, 'document.querySelectorAll(".d-days button")[1].click()');
      if (reduced) for (const x of [fwd, bwd]) assert.deepEqual(x, [{ on: "d-daybox", duration: 150, easing: "linear", from: { opacity: "0", transform: undefined } }]);
      else {
        assert.deepEqual(fwd, [{ on: "d-daybox", duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", from: { opacity: "0", transform: "translateX(12px)" } }]);
        assert.deepEqual(bwd.map(x => x.from.transform), ["translateX(-12px)"], "back: from the other side");
      }
      assert.deepEqual(await arrivals(page, 'document.querySelectorAll(".d-days button")[1].click()'), [], "the same day again: nothing");
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  test(`folds glide open where the browser can${reduced ? ", not under reduced motion" : ""}`, async () => {
    const { page, errors, close } = await open("iPhone 13", reduced ? "reduce" : "no-preference");
    try {
      await settle(page);
      await page.locator("#i-rows .brow").first().click();
      await page.locator("details.ui-fold").first().waitFor({ state: "attached" }); await settle(page);
      const r = await page.evaluate(() => {
        const d = document.querySelector("details.ui-fold");
        return CSS.supports("selector(::details-content)") ? getComputedStyle(d, "::details-content").transitionDuration : null;
      });
      if (r !== null) assert.equal(r, reduced ? "0s" : "0.25s, 0.25s");
      // Opened, it ends at its full height either way.
      const fold = page.locator("details.ui-fold").first();
      await fold.evaluate(d => { d.open = true; });
      await page.waitForTimeout(400);
      const h = await fold.evaluate(d => ({ all: d.getBoundingClientRect().height, sum: d.querySelector("summary").getBoundingClientRect().height }));
      assert.ok(h.all > h.sum + 10, `the fold's content shows (${h.all} > ${h.sum})`);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });
}
