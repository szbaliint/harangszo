// jogi.html: the legal page, its links from the map / suggestion form / parish sign-up, and the statistics opt-out.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, devices } from "./helpers/playwright.mjs";
import { startServer, ROOT } from "./helpers/server.mjs";
import { mockSupabase } from "./helpers/supabase-mock.mjs";

const { defaultBrowserType: _, ...IPHONE } = devices["iPhone 13"];
let server, browser;
before(async () => { server = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.stop(); });
const ctx = async (o = {}) => { const c = await browser.newContext({ ...IPHONE, serviceWorkers: "block", ...o }); const p = await c.newPage(); const errors = []; p.on("pageerror", e => errors.push(e.message)); return { c, p, errors }; };

test("the legal page has the three sections and fits a phone", async () => {
  const { c, p, errors } = await ctx();
  try {
    await p.goto(server.url + "/jogi.html");
    for (const id of ["impresszum", "adatkezeles", "feltetelek"]) assert.equal(await p.locator("#" + id).count(), 1, id);
    const text = await p.locator("main").innerText();
    for (const s of ["GDPR", "NAIH", "Supabase", "GitHub", "OpenStreetMap", "sütiket nem használunk", "harangszo.saved.v1"]) assert.ok(text.toLowerCase().includes(s.toLowerCase()), s);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll");
    assert.deepEqual(errors, []);
  } finally { await c.close(); }
});

test("the opt-out switch sets the flag analytics.js reads, and back", async () => {
  const { c, p } = await ctx();
  try {
    await p.goto(server.url + "/jogi.html");
    await p.click("#track-toggle");
    assert.equal(await p.evaluate(() => localStorage.getItem("harangszo.notrack")), "1");
    assert.match(await p.locator("#track-state").innerText(), /ki van kapcsolva/);
    await p.click("#track-toggle");
    assert.equal(await p.evaluate(() => localStorage.getItem("harangszo.notrack")), null);
  } finally { await c.close(); }
});

test("with Do Not Track the page says so instead of offering the switch", async () => {
  const { c, p } = await ctx();
  try {
    await p.addInitScript(() => Object.defineProperty(Navigator.prototype, "doNotTrack", { get: () => "1" }));
    await p.goto(server.url + "/jogi.html");
    assert.match(await p.locator("#track-state").innerText(), /Ne kövessenek/);
    assert.equal(await p.locator("#track-toggle").isVisible(), false);
  } finally { await c.close(); }
});

test("links: map menu, suggestion form and parish sign-up point to the legal page", async () => {
  const { c, p } = await ctx();
  try {
    await mockSupabase(p, { rpc: { public_data: () => [{ id: 101, name: "Szent István-bazilika", city: "Budapest", address: "Szent István tér 1.", rite: "rk", lat: 47.5, lon: 19.05, imp: 90, services: [{ kind: "mass", days: [0, 1, 2, 3, 4, 5, 6], start: "18:00" }] }], track: () => null } });
    await p.goto(server.url + "/index.html");
    await p.locator("#nearest .nx").first().waitFor({ timeout: 15000 });
    assert.equal(await p.locator('#menu a[href="jogi.html"]').count(), 1);
    await p.locator("#nearest .nx").first().click();
    await p.locator("#go-suggest").click();
    assert.equal(await p.locator('#suggest a[href="jogi.html#adatkezeles"]').count(), 1);
    const q = await browser.newContext({ ...IPHONE }); const pp = await q.newPage();
    await mockSupabase(pp, {}); await pp.goto(server.url + "/plebania.html");
    await pp.locator('[data-mode="signup"]').click();
    assert.equal(await pp.locator('a[href="jogi.html#feltetelek"]').count(), 1);
    assert.equal(await pp.locator('a[href="jogi.html#adatkezeles"]').count(), 1);
    await q.close();
  } finally { await c.close(); }
});

test("jogi.html is deployed", () => {
  const cp = readFileSync(path.join(ROOT, ".github/workflows/pages.yml"), "utf8").split("\n").find(l => /^\s*cp index\.html/.test(l));
  assert.ok(cp.split(/\s+/).includes("jogi.html"));
});
