// Anonymous statistics: what the map sends to track(), and when it sends nothing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, devices } from "./helpers/playwright.mjs";
import { startServer, ROOT } from "./helpers/server.mjs";
import { mockSupabase } from "./helpers/supabase-mock.mjs";

const { defaultBrowserType: _, ...IPHONE } = devices["iPhone 13"];
const NOW = new Date("2026-11-09T06:30:00+01:00"); // a Monday morning
const CHURCHES = [
  { id: 101, name: "Szent István-bazilika", city: "Budapest", address: "Szent István tér 1.", rite: "rk", lat: 47.5009, lon: 19.0539, imp: 90, phone: "+36 1 311 0839", website: "bazilika.biz",
    services: [{ kind: "mass", days: [0, 1, 2, 3, 4, 5, 6], start: "18:00" }, { kind: "confession", days: [1], start: "17:00", end: "17:45" }] },
  { id: 102, name: "Ferences templom", city: "Budapest", address: "Ferenciek tere 9.", rite: "rk", lat: 47.4925, lon: 19.0560, imp: 80,
    services: [{ kind: "mass", days: [1, 2, 3, 4, 5], start: "07:00" }] },
];
let server, browser;
before(async () => { server = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.stop(); });

async function open({ url = "/index.html?track=1", init, view = IPHONE } = {}) {
  const context = await browser.newContext({ ...view, timezoneId: "Europe/Budapest", serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  if (init) await page.addInitScript(init);
  const { calls } = await mockSupabase(page, { rpc: { public_data: () => CHURCHES, track: () => null } });
  await page.clock.setFixedTime(NOW);
  await page.goto(server.url + url);
  await page.locator("#nearest .nx").first().waitFor({ timeout: 15000 });
  // every event sent so far, flattened
  const events = async () => { await page.evaluate(() => window.Track.flush()); await page.waitForTimeout(150);
    return calls.filter(c => c.path === "/rest/v1/rpc/track").flatMap(c => c.body.p).map(x => x.e + (x.k ? ":" + x.k : "")); };
  return { page, calls, events, errors, close: () => context.close() };
}

test("a visit, a church page and its actions are counted, with nothing that identifies the visitor", async () => {
  const t = await open();
  try {
    let ev = await t.events();
    for (const e of ["visit", "visitor", "new_visitor", "device:phone", "mode:browser"]) assert.ok(ev.includes(e), `${e} in ${ev}`);
    await t.page.locator("#nearest .nx").first().click();
    await t.page.locator("h2.d-name").waitFor();
    await t.page.locator("#save-church").click();
    await t.page.locator("a.d-act", { hasText: "Útvonal" }).evaluate(a => { a.addEventListener("click", e => e.preventDefault()); a.click(); });
    // the same church again is still one view
    await t.page.locator("#back").click(); await t.page.locator("#nearest .nx, .lcard").first().waitFor();
    ev = await t.events();
    assert.equal(ev.filter(e => e === "view:101").length, 1, String(ev));
    assert.ok(ev.includes("save:101") && ev.includes("dir:101"), String(ev));
    // the request carries only event names and keys
    const bodies = t.calls.filter(c => c.path === "/rest/v1/rpc/track").map(c => c.body);
    for (const b of bodies) { assert.deepEqual(Object.keys(b), ["p"]); for (const x of b.p) assert.ok(Object.keys(x).every(k => k === "e" || k === "k"), JSON.stringify(x)); }
    assert.equal(await t.page.evaluate(() => document.cookie), "");
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test("a reload in the same tab is not a new visit; the next day counts the visitor again but not as new", async () => {
  const t = await open();
  try {
    await t.events();
    await t.page.reload(); await t.page.locator("#nearest .nx").first().waitFor();
    let ev = await t.events();
    assert.equal(ev.filter(e => e === "visit").length, 1, String(ev));
    // a new tab session on the next day
    await t.page.evaluate(() => { sessionStorage.clear(); localStorage.setItem("harangszo.seen", "2026-11-08"); });
    await t.page.reload(); await t.page.locator("#nearest .nx").first().waitFor();
    ev = await t.events();
    assert.equal(ev.filter(e => e === "visit").length, 2); assert.equal(ev.filter(e => e === "visitor").length, 2);
    assert.equal(ev.filter(e => e === "new_visitor").length, 1, String(ev));
  } finally { await t.close(); }
});

test("filters, tabs and searches are counted; a search with no result is kept apart", async () => {
  const t = await open();
  try {
    await t.page.locator('#chips [data-f="conf"]').click();
    await t.page.locator('#chips [data-f="conf"]').click(); // switching it off is not counted
    await t.page.locator('.ui-tab[data-tab="list"]').click();
    await t.page.fill("#q", "Ferences"); await t.page.waitForTimeout(2300);
    await t.page.fill("#q", "Nincsilyen Templom"); await t.page.waitForTimeout(2300);
    await t.page.fill("#q", "ab"); await t.page.waitForTimeout(2300); // too short
    const ev = await t.events();
    assert.equal(ev.filter(e => e === "filter:conf").length, 1, String(ev));
    assert.ok(ev.includes("tab:list") && ev.includes("search:ferences") && ev.includes("search_none:nincsilyen templom"), String(ev));
    assert.ok(!ev.some(e => e.endsWith(":ab")), String(ev));
  } finally { await t.close(); }
});

for (const [name, init, url] of [
  ["Do Not Track", () => Object.defineProperty(Navigator.prototype, "doNotTrack", { get: () => "1" })],
  ["Global Privacy Control", () => Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true })],
  ["the admin's own device (harangszo.notrack)", () => localStorage.setItem("harangszo.notrack", "1")],
  ["an automated browser", undefined, "/index.html"],
]) test(`nothing is sent with ${name}`, async () => {
  const t = await open({ init, url });
  try {
    await t.page.locator("#nearest .nx").first().click(); await t.page.locator("h2.d-name").waitFor();
    assert.deepEqual(await t.events(), []);
    assert.equal(await t.page.evaluate(() => window.Track.off), true);
  } finally { await t.close(); }
});

test("blocked storage: the page works and a visit is still counted", async () => {
  const t = await open({ init: () => { for (const s of ["localStorage", "sessionStorage"]) Object.defineProperty(window, s, { get() { throw new Error("blocked"); } }); } });
  try { const ev = await t.events(); assert.ok(ev.includes("visit") && !ev.includes("visitor"), String(ev)); assert.deepEqual(t.errors, []); }
  finally { await t.close(); }
});

test("analytics.js is deployed and precached; the menu says so", () => {
  const cp = readFileSync(path.join(ROOT, ".github/workflows/pages.yml"), "utf8").split("\n").find(l => /^\s*cp index\.html/.test(l));
  assert.ok(cp.split(/\s+/).includes("analytics.js"));
  assert.ok(readFileSync(path.join(ROOT, "sw.js"), "utf8").includes('"analytics.js"'));
  assert.match(readFileSync(path.join(ROOT, "index.html"), "utf8"), /névtelen látogatási statisztikát/);
});
