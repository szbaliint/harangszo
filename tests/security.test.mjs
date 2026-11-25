// Security regressions from the 2026-11-25 review: text a parish editor (or an import) stores must never become
// markup on the public map, links from the database must be https, and every page forbids inline event handlers.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, devices } from "./helpers/playwright.mjs";
import { startServer, ROOT } from "./helpers/server.mjs";
import { mockSupabase } from "./helpers/supabase-mock.mjs";

const { defaultBrowserType: _, ...IPHONE } = devices["iPhone 13"];
const PAYLOAD = `<img src="x" class="pwn" onerror="window.__pwned=1">`;
const today = "2026-11-25";
const DATA = [{
  id: 301, name: "Szent Anna-templom", city: "Budapest", address: "Batthyány tér 7.", rite: "rk", lat: 47.5065, lon: 19.0385, imp: 80,
  services: [
    { kind: "prayer", days: [0, 1, 2, 3, 4, 5, 6], start: "17:00", note: PAYLOAD },
    { kind: "mass", days: [0, 1, 2, 3, 4, 5, 6], start: "18:00" },
  ],
  dated: [{ date: today, kind: "mass", start: "19:00", url: "javascript:window.__pwned=2" }],
}];

let server, browser;
before(async () => { server = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.stop(); });

test("a prayer's name with markup stays text, and a javascript: source link never reaches an href", async () => {
  const context = await browser.newContext({ ...IPHONE, timezoneId: "Europe/Budapest", serviceWorkers: "block" });
  const page = await context.newPage();
  try {
    await mockSupabase(page, { rpc: { public_data: () => DATA, track: () => null } });
    await page.clock.setFixedTime(new Date(`${today}T16:40:00+01:00`));   // a Wednesday
    await page.goto(server.url + "/index.html#t=301");
    await page.waitForFunction(() => document.body.textContent.includes("Szent Anna-templom") && document.querySelector(".week, #f-week"), null, { timeout: 15000 });
    await page.evaluate(() => document.querySelectorAll("details").forEach(d => { d.open = true; }));
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => ({
      injected: document.querySelectorAll("img.pwn, img[src='x']").length,
      pwned: window.__pwned || 0,
      shownAsText: document.body.textContent.includes('<img src="x"'),
      jsLinks: [...document.querySelectorAll("a[href]")].filter(a => /^\s*javascript:/i.test(a.getAttribute("href"))).length,
    }));
    assert.equal(r.injected, 0, "no element was created from the note");
    assert.equal(r.pwned, 0, "nothing ran");
    assert.ok(r.shownAsText, "the note is shown literally");
    assert.equal(r.jsLinks, 0, "no javascript: link");
  } finally { await context.close(); }
});

test("every page forbids inline event-handler attributes, plugins and <base> rewriting", () => {
  for (const f of ["index.html", "plebania.html", "admin.html", "jogi.html"]) {
    const html = readFileSync(path.join(ROOT, f), "utf8");
    const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
    assert.ok(m, `${f} has a CSP meta`);
    for (const d of ["script-src-attr 'none'", "object-src 'none'", "base-uri 'self'"]) assert.ok(m[1].includes(d), `${f}: ${d}`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, `${f} has no inline on* handler attribute`);
  }
});
