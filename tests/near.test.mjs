// "Közel most": one tap from Most lists the nearby churches with a Mass or confession still to come today,
// nearest first, their times, and "most tart" (red) for a confession going on now. Live mode, fake Supabase.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, devices } from "./helpers/playwright.mjs";
import { startServer } from "./helpers/server.mjs";
import { mockSupabase } from "./helpers/supabase-mock.mjs";

const { defaultBrowserType: _, ...IPHONE } = devices["iPhone 13"];
const DATA = [
  { id: 201, name: "Mátyás-templom", city: "Budapest", address: "Szentháromság tér 2.", rite: "rk", lat: 47.502, lon: 19.0344, imp: 90,
    services: [{ kind: "mass", days: [6], start: "18:00" }, { kind: "mass", days: [6], start: "18:00", note: "németül" }, { kind: "mass", days: [6], start: "08:00" }] },
  { id: 202, name: "Szent Anna-templom", city: "Budapest", address: "Batthyány tér 7.", rite: "rk", lat: 47.5065, lon: 19.0385, imp: 80,
    services: [{ kind: "mass", days: [6], start: "18:30" }, { kind: "confession", days: [6], start: "17:00", end: "17:45" }] },
  { id: 203, name: "Kapucinus templom", city: "Budapest", address: "Fő utca 32.", rite: "rk", lat: 47.5045, lon: 19.0390, imp: 70,
    services: [{ kind: "mass", days: [6], start: "07:00" }] },   // nothing left today: not listed
];

let server, browser;
before(async () => { server = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.stop(); });

async function open(time, geo = true) {
  const context = await browser.newContext({ ...IPHONE, timezoneId: "Europe/Budapest", serviceWorkers: "block",
    ...(geo ? { geolocation: { latitude: 47.5055, longitude: 19.0375 }, permissions: ["geolocation"] } : {}) });
  const page = await context.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await mockSupabase(page, { rpc: { public_data: () => DATA, track: () => null } });
  await page.clock.setFixedTime(new Date(`2026-11-14T${time}:00+01:00`)); // a Saturday
  await page.goto(server.url + "/index.html");
  await page.locator("#m-name").waitFor({ timeout: 15000 });
  return { page, errors, close: () => context.close() };
}
const rows = page => page.locator("#near-results .n-row").evaluateAll(bs => bs.map(b => ({
  name: b.querySelector(".r-name").textContent, lines: [...b.querySelectorAll(".n-line")].map(l => (l.querySelector(".n-k").textContent + " " + l.querySelector(".n-ts").textContent).replace(/\s+/g, " ").trim()) })));

test("Közel most: nearest first, only churches with something left today, from the visitor's position", async () => {
  const { page, errors, close } = await open("16:40");
  try {
    await page.locator("#m-near").click();
    await page.locator("#near-results .n-row").first().waitFor({ timeout: 10000 });
    await page.locator("#near-filters .n-from", { hasText: "a helyzetedtől" }).waitFor({ timeout: 10000 });
    assert.deepEqual(await rows(page), [
      { name: "Szent Anna-templom", lines: ["Mise 18:30", "Gyónás 17:00–17:45"] },
      { name: "Mátyás-templom", lines: ["Mise 18:00"] },
    ]);
    assert.equal(await page.locator("#near-results .now").count(), 0, "nothing is going on yet");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("Közel most: a confession going on now says 'most tart' in red; Gyónás shows only confessions; a row opens the church", async () => {
  const { page, close } = await open("17:10");
  try {
    await page.locator("#m-near").click();
    await page.locator("#near-results .n-row").first().waitFor({ timeout: 10000 });
    const now = page.locator("#near-results .now");
    assert.equal(await now.textContent(), "most tart");
    assert.equal(await now.evaluate(e => getComputedStyle(e).color), "rgb(180, 35, 42)");
    await page.locator('#near-filters [data-nk="conf"]').click();
    assert.deepEqual(await rows(page), [{ name: "Szent Anna-templom", lines: ["Gyónás 17:00–17:45 most tart"] }]);
    await page.locator("#near-results .n-row").first().click();
    await page.waitForFunction(() => document.querySelector("#near").dataset.open === "false");
    await page.locator(".d-name", { hasText: "Szent Anna-templom" }).waitFor({ timeout: 5000 });
  } finally { await close(); }
});

test("Közel most without a position: measured from the chosen town, and it says so; Kész closes it", async () => {
  const { page, close } = await open("16:40", false);
  try {
    await page.locator("#m-near").click();
    await page.locator("#near-results .n-row").first().waitFor({ timeout: 10000 });
    assert.match(await page.locator("#near-filters .n-from").textContent(), /távolság: Budapest/);
    await page.locator("#near-done").click();
    assert.equal(await page.locator("#near").getAttribute("data-open"), "false");
    assert.equal(await page.evaluate(() => document.activeElement.id), "m-near", "focus returns to the button");
  } finally { await close(); }
});
