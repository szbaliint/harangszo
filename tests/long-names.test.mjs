// Task 8 (Review Focus 1): a very long church name wraps in every view — Most, a search result row, the church page
// header, parish portal header, admin list and admin header — at 360px and 1440px, without overflowing its box
// or covering a button in the same header.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { chromium } from "./helpers/playwright.mjs";
import { startServer } from "./helpers/server.mjs";
import { mockSupabase } from "./helpers/supabase-mock.mjs";

const LONG = "Budapest-Belvárosi Nagyboldogasszony Főplébánia-templom (Belvárosi templom)";
const NOW = new Date("2026-11-09T06:30:00+01:00");
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const PHONE = { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const VIEWS = { 360: PHONE, 1440: { viewport: { width: 1440, height: 900 } } };
// Optional: LONG_NAMES_SHOTS=<dir> saves a screenshot of each view.
const SHOTS = process.env.LONG_NAMES_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let server, browser;
before(async () => { server = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.stop(); });

async function context(view) {
  const ctx = await browser.newContext({ ...VIEWS[view], timezoneId: "Europe/Budapest" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.clock.setFixedTime(NOW);
  return { ctx, page, errors };
}
const shot = (page, name) => SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null;

// For the name element `sel`: it shows the long name, does not overflow sideways, and its box intersects none of
// the elements `others` (buttons and the like in the same header). Returns the measurements for extra checks.
async function check(page, sel, others, label) {
  const r = await page.evaluate(([sel, others]) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
    const hits = [...document.querySelectorAll(others)].filter(o => o !== el && !o.contains(el) && !el.contains(o)).map(o => {
      const a = o.getBoundingClientRect();
      return a.width && a.height && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5 ? (o.id || o.className || o.tagName) : null;
    }).filter(Boolean);
    return { text: el.textContent.trim(), sw: el.scrollWidth, cw: el.clientWidth, h: b.height, lh: parseFloat(cs.lineHeight), right: b.right, vw: document.documentElement.clientWidth, pageSw: document.documentElement.scrollWidth, hits };
  }, [sel, others]);
  assert.ok(r, `${label}: ${sel} is missing`);
  assert.equal(r.text, LONG, `${label}: shows the long name`);
  assert.ok(r.sw <= r.cw + 1, `${label}: name overflows (${r.sw} > ${r.cw})`);
  assert.ok(r.right <= r.vw + 1, `${label}: name runs off the screen`);
  assert.ok(r.pageSw <= r.vw, `${label}: page scrolls sideways (${r.pageSw} > ${r.vw})`);
  assert.deepEqual(r.hits, [], `${label}: name covers ${r.hits.join(", ")}`);
  return r;
}

async function openMap(view) {
  const { ctx, page, errors } = await context(view);
  await page.route("**/data.js", async route => {
    const res = await route.fetch();
    const body = (await res.text()).replace(`name:"Nagyboldogasszony-templom (Mátyás-templom)"`, `name:${JSON.stringify(LONG)}`);
    await route.fulfill({ response: res, body });
  });
  await page.route(/commons\.wikimedia\.org/, r => r.abort());
  await page.goto(`${server.url}/index.html`);
  await page.waitForSelector("#m-name");
  return { page, errors, close: () => ctx.close() };
}

for (const view of Object.keys(VIEWS)) {
  test(`map: Most, a result row and the church page (${view})`, async () => {
    const { page, errors, close } = await openMap(view);
    try {
      // Most: the long name (the nearest church with a Mass to come) wraps, clear of the time and the buttons.
      const m = await check(page, "#m-name", "#m-when, #m-when *, .most .acts, .most .acts > *, .most .top-plain button", "Most");
      assert.ok(Math.round(m.h / m.lh) >= 2, "Most: the name wraps instead of cutting off");
      await shot(page, `most-${view}`);
      await page.click("#m-search");
      await page.locator('#s-results .row[data-id="2"]').waitFor();
      await check(page, '#s-results .row[data-id="2"] .r-name', '#s-results .row[data-id="2"] .r-d, #s-results .row[data-id="2"] .r-t', "result row");
      await shot(page, `list-${view}`);
      await page.click('#s-results .row[data-id="2"]');
      await page.waitForSelector('.detail[data-id="2"]');
      await page.waitForTimeout(400); // the page's slide-in
      await check(page, "h2.d-name", ".d-bar button, .d-actions, .d-actions a, .d-actions button, #d-next, #d-next *", "detail");
      await shot(page, `detail-${view}`);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  test(`portal header (${view})`, async () => {
    const { ctx, page, errors } = await context(view);
    try {
      const parish = fixture("staff-parish.json"), church = { ...fixture("church-1043.json"), name: LONG };
      await mockSupabase(page, { user: parish.user, staff: parish.staff, tables: { staff_churches: parish.staff_churches, churches: [church] }, rpc: { save_church: () => 1043 } });
      await page.goto(`${server.url}/plebania.html`);
      await page.locator(".se-day").first().waitFor({ timeout: 15000 });
      await check(page, "h1.pp-name", "#top button, #top a, #top select", "portal");
      await shot(page, `portal-${view}`);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test(`admin list and header (${view})`, async () => {
    const { ctx, page, errors } = await context(view);
    try {
      const admin = fixture("staff-admin.json"), church = { ...fixture("church-1043.json"), name: LONG };
      const row = { id: church.id, name: LONG, city: church.city, published: true, n_services: 7, has_confession: true, has_rorate: false, has_feast: true, n_pending: 2,
        importance: 60, importance_manual: null, from_osm: true, location_approx: false, schedule_source: null, schedule_locked: true, near_duplicate: false, created_by: null };
      await mockSupabase(page, { user: admin.user, staff: admin.staff, tables: { churches: [church], admin_church_list: [row], suggestions: [], access_requests: [], parish_editors: [], church_edits: [] },
        rpc: { save_church: () => 1043 } });
      await page.goto(`${server.url}/admin.html`);
      await page.locator("#clist .ad-it").first().waitFor({ timeout: 15000 });
      await check(page, "#clist .ad-it .nm", "#clist .ad-it .sub, #clist .ad-it .sub *", "admin list");
      await page.locator("#clist .ad-it").first().click();
      await page.locator(".se-day").first().waitFor();
      await check(page, "h1.ad-name", ".ad-ch button, .ad-ch a, .ad-ch label, .ad-ch input", "admin header");
      await shot(page, `admin-${view}`);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });
}
