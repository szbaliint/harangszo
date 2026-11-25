// Not a test (no .test.mjs): screenshots of the public app for a design review, against the fake Supabase with a fixed
// clock (Wednesday 25 November 2026, 17:48, Budapest). Run: node tests/shots.mjs <out dir>
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "./helpers/playwright.mjs";
import { startServer, ROOT } from "./helpers/server.mjs";
import { mockSupabase } from "./helpers/supabase-mock.mjs";

const OUT = process.argv[2] || "shots"; mkdirSync(OUT, { recursive: true });
const DATA = JSON.parse(readFileSync(new URL("./fixtures/board-churches.json", import.meta.url), "utf8"));
const NOW = new Date("2026-11-25T17:48:00+01:00");
const HERE = { latitude: 47.5062, longitude: 19.0392 }; // Batthyány tér
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESK = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const photo = name => path.join(ROOT, ".impeccable/mocks/decision/photos", name + ".jpg");

const server = await startServer(), browser = await chromium.launch();
async function open({ view = PHONE, scheme = "light", geo = true, now = NOW, data = DATA, photos = true } = {}) {
  const ctx = await browser.newContext({ ...view, timezoneId: "Europe/Budapest", colorScheme: scheme, serviceWorkers: "block", reducedMotion: "reduce",
    ...(geo ? { geolocation: HERE, permissions: ["geolocation"] } : {}) });
  const page = await ctx.newPage();
  page.on("pageerror", e => console.error("pageerror:", e.message));
  await mockSupabase(page, { rpc: { public_data: () => photos ? data : data.map(({ photo_url, ...c }) => c), track: () => null } });
  await page.route(/upload\.wikimedia\.org\/test\/(\w+)\.jpg/, r => r.fulfill({ status: 200, contentType: "image/jpeg", body: readFileSync(photo(/(\w+)\.jpg/.exec(r.request().url())[1])) }));
  await page.clock.setFixedTime(now);
  await page.goto(server.url + "/index.html");
  await page.locator("#i-rows, #i-empty .board-empty").first().waitFor({ state: "attached", timeout: 15000 });
  if (geo) { await page.locator("#i-locate").click(); await page.locator("#i-line", { hasText: "a helyzeted" }).waitFor(); }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  return { page, close: () => ctx.close() };
}
const settle = page => page.waitForFunction(() => !/\bvt-/.test(document.documentElement.className)).then(() => page.waitForTimeout(450));
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + ".png") });

for (const scheme of ["light", "dark"]) {
  let t = await open({ scheme }); await shot(t.page, `indulasok-${scheme}`); await t.close();
  t = await open({ scheme, photos: false }); await shot(t.page, `indulasok-nophoto-${scheme}`); await t.close();
  t = await open({ scheme, geo: false }); await shot(t.page, `indulasok-nolocation-${scheme}`); await t.close();
  t = await open({ scheme, now: new Date("2026-11-25T21:30:00+01:00") }); await shot(t.page, `indulasok-evening-${scheme}`); await t.close();
  t = await open({ scheme });
  await t.page.locator(".pass-open").click(); await settle(t.page); await shot(t.page, `church-${scheme}`);
  await t.page.locator("#col").evaluate(e => e.scrollTo(0, 560)); await t.page.waitForTimeout(200); await shot(t.page, `church-scrolled-${scheme}`);
  await t.page.locator("#back").click(); await settle(t.page);
  await t.page.locator('.tab[data-tab="map"]').click(); await settle(t.page); await t.page.waitForTimeout(1200); await shot(t.page, `terkep-${scheme}`);
  await t.page.locator('.tab[data-tab="list"]').click(); await settle(t.page); await t.page.locator("#q").blur(); await shot(t.page, `kereses-${scheme}`);
  await t.page.locator('.tab[data-tab="saved"]').click(); await settle(t.page); await shot(t.page, `mentett-empty-${scheme}`);
  await t.page.evaluate(() => { for (const id of [403, 402]) Saved.toggle(id); render(); }); await shot(t.page, `mentett-${scheme}`);
  await t.close();
}
let t = await open({ view: DESK }); await shot(t.page, "desktop-indulasok");
await t.page.locator(".pass-open").click(); await settle(t.page); await t.page.waitForTimeout(800); await shot(t.page, "desktop-church");
await t.close();
await browser.close(); await server.stop();
console.log("saved to", OUT);
