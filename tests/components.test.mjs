// Task 2: shared ui- components on the fixture page tests/fixtures/components.html.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "./helpers/playwright.mjs";
import { startServer } from "./helpers/server.mjs";

let server, browser;
before(async () => { server = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.stop(); });

async function open(viewport, opts = {}) {
  const page = await browser.newPage({ viewport });
  if (opts.reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${server.url}/tests/fixtures/components.html${opts.query || ""}`);
  await page.evaluate(() => document.fonts.ready);
  return page;
}
const finished = page => page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => { }))));

for (const theme of ["light", "dark"]) {
  test(`tap targets are at least 44px (${theme})`, async () => {
    const page = await open({ width: 390, height: 844 }, { query: theme === "dark" ? "?theme=dark" : "" });
    try {
      const sel = ".ui-btn, .ui-chip, .ui-tab, .ui-daypick button, .ui-field input, .ui-seg button";
      const small = await page.$$eval(sel, els => els
        .filter(e => e.checkVisibility({ visibilityProperty: true }))
        // A chip is drawn smaller; its ::before extends the tap area (inset -5px top and bottom).
        .map(e => ({ h: e.getBoundingClientRect().height + (e.matches(".ui-chip") && getComputedStyle(e, "::before").content !== "none" ? -2 * parseFloat(getComputedStyle(e, "::before").top) : 0), what: e.className || e.tagName + " " + e.textContent.trim() }))
        .filter(x => x.h < 44));
      const count = await page.locator(sel).count();
      assert.ok(count >= 20, `fixture shows the components (${count})`);
      assert.deepEqual(small, [], "elements under 44px tall");
    } finally { await page.close(); }
  });

  test(`accent colours follow the tokens (${theme})`, async () => {
    const page = await open({ width: 390, height: 844 }, { query: theme === "dark" ? "?theme=dark" : "" });
    try {
      const r = await page.evaluate(() => {
        const probe = document.createElement("i");
        probe.style.color = "var(--accent)";
        document.body.append(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        return {
          accent,
          dark: document.documentElement.dataset.theme === "dark",
          primary: getComputedStyle(document.querySelector(".ui-btn.primary")).backgroundColor,
          chip: getComputedStyle(document.querySelector('.ui-chip[aria-pressed="true"]')).borderTopColor,
        };
      });
      assert.equal(r.dark, theme === "dark");
      assert.equal(r.primary, r.accent, ".ui-btn.primary background is --accent");
      assert.equal(r.chip, r.accent, "pressed .ui-chip border is --accent");
    } finally { await page.close(); }
  });
}

test("dialog.ui-sheet is a bottom sheet on a phone", async () => {
  const page = await open({ width: 390, height: 844 });
  try {
    await page.evaluate(() => document.querySelector("dialog.ui-sheet").showModal());
    await finished(page);
    const b = await page.evaluate(() => document.querySelector("dialog.ui-sheet").getBoundingClientRect().toJSON());
    assert.ok(Math.abs(b.bottom - 844) <= 1, `touches the bottom (bottom ${b.bottom})`);
    assert.ok(b.left <= 0.5 && Math.abs(b.right - 390) <= 0.5, `full width (${b.left}–${b.right})`);
  } finally { await page.close(); }
});

test("dialog.ui-sheet is a centred panel on a wide screen", async () => {
  const page = await open({ width: 1024, height: 768 });
  try {
    await page.evaluate(() => document.querySelector("dialog.ui-sheet").showModal());
    await finished(page);
    const b = await page.evaluate(() => document.querySelector("dialog.ui-sheet").getBoundingClientRect().toJSON());
    assert.ok(Math.abs((b.left + b.right) / 2 - 512) <= 1, `centred horizontally (${b.left}–${b.right})`);
    assert.ok(Math.abs((b.top + b.bottom) / 2 - 384) <= 1, `centred vertically (${b.top}–${b.bottom})`);
    assert.ok(b.width <= 620, `at most 620px wide (${b.width})`);
    assert.ok(b.bottom < 768, "does not touch the bottom");
  } finally { await page.close(); }
});

test("nothing moves under prefers-reduced-motion", async () => {
  const page = await open({ width: 390, height: 844 }, { reducedMotion: "reduce" });
  try {
    const d = await page.evaluate(() => ["dialog.ui-sheet", ".ui-toast", ".ui-savebar", ".ui-btn", ".ui-chip"]
      .map(s => [s, getComputedStyle(document.querySelector(s)).transitionDuration]));
    for (const [s, v] of d) assert.equal(v, "0s", `${s} transition-duration`);
  } finally { await page.close(); }
});
