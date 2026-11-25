// Task 6: the parish portal — week board from the shared schedule editor, save bar, toast, phone preview switch.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium, devices } from "./helpers/playwright.mjs";
import { startServer } from "./helpers/server.mjs";
import { mockSupabase } from "./helpers/supabase-mock.mjs";
import { typeProblems } from "./helpers/type-check.mjs";

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const { defaultBrowserType: _, ...IPHONE } = devices["iPhone 13"];
const LAPTOP = { viewport: { width: 1280, height: 800 } };
// A Monday morning in Budapest.
const NOW = new Date("2026-11-09T09:00:00+01:00");

let server, browser;
before(async () => { server = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.stop(); });

async function open({ view = IPHONE, signedIn = true, saveChurch } = {}) {
  const context = await browser.newContext({ ...view, timezoneId: "Europe/Budapest" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  const parish = fixture("staff-parish.json"), church = fixture("church-1043.json");
  const { calls } = await mockSupabase(page, signedIn ? {
    user: parish.user, staff: parish.staff,
    tables: { staff_churches: parish.staff_churches, churches: [church] },
    rpc: { save_church: saveChurch || (() => 1043) },
  } : {});
  await page.clock.setFixedTime(NOW);
  await page.goto(`${server.url}/plebania.html`);
  if (signedIn) await page.locator(".se-day").first().waitFor({ timeout: 15000 });
  return { page, calls, errors, church, close: () => context.close() };
}
const day = (page, name) => page.locator(".se-day", { has: page.getByText(name, { exact: true }) });
async function addTime(page, dayName, time) {
  await page.getByRole("button", { name: `Időpont hozzáadása: ${dayName}` }).click();
  const sheet = page.locator("dialog.se-sheet");
  await sheet.waitFor({ state: "visible" });
  await sheet.locator(".se-start").fill(time);
  await sheet.getByRole("button", { name: "Hozzáadás" }).click();
  await sheet.waitFor({ state: "hidden" });
}

test("opens the church: header, four tabs, a card per day with the fixture's times", async () => {
  const { page, errors, church, close } = await open();
  try {
    assert.equal((await page.locator("h1.pp-name").textContent()).trim(), church.name);
    assert.match(await page.locator(".pp-state").textContent(), /Látható a térképen/);
    assert.deepEqual((await page.locator(".ui-tabbar .ui-tab").allTextContents()).map(s => s.trim()), ["Heti rend", "Ünnepek", "Események", "Adatok"]);
    assert.equal(await page.locator(".se-day").count(), 7);
    assert.deepEqual(await day(page, "Vasárnap").locator(".se-tile:not(.se-add) b").allTextContents(), ["08:00", "10:00", "18:00"]);
    assert.deepEqual(await day(page, "Hétfő").locator(".se-tile:not(.se-add) b").allTextContents(), ["07:00", "18:00"]);
    assert.deepEqual(await typeProblems(page), [], "portal week board");
    assert.equal(await page.locator("#savebar.on").count(), 0, "no save bar before a change");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("adding a time shows the save bar; Mentés sends it with schedule_locked and shows the toast", async () => {
  const { page, calls, errors, close } = await open();
  try {
    await addTime(page, "Kedd", "19:30");
    assert.equal(await day(page, "Kedd").locator(".se-tile b", { hasText: "19:30" }).count(), 1);
    await page.locator("#savebar.on").waitFor();
    assert.equal((await page.locator("#savestate").textContent()).trim(), "1 nem mentett változás");
    await page.locator("#save").click();
    await page.locator("#toast.on").waitFor();
    assert.equal((await page.locator("#toast").textContent()).trim(), "Elmentve · már látszik a térképen");
    const call = calls.find(c => c.path === "/rest/v1/rpc/save_church");
    assert.ok(call, "save_church was called");
    const p = call.body.p;
    assert.equal(p.schedule_locked, true);
    assert.equal(p.id, 1043);
    assert.ok(p.services.some(s => s.kind === "mass" && s.start === "19:30" && JSON.stringify(s.days) === "[2]" && !s.feast), JSON.stringify(p.services));
    // Existing rules and the feast row are still there, in the stored shape.
    assert.ok(p.services.some(s => s.kind === "mass" && s.start === "07:00" && JSON.stringify(s.days) === "[1,2,3,4,5]" && s.every === null && s.anchor === ""));
    assert.ok(p.services.some(s => s.kind === "adoration" && JSON.stringify(s.weeks) === "[1]" && s.end === "19:30"));
    assert.ok(p.services.some(s => s.feast === "aug15" && s.start === "09:00" && JSON.stringify(s.days) === "[]"));
    assert.deepEqual(p.feast_sunday, ["jan6"]);
    await page.waitForFunction(() => !document.querySelector("#savebar").classList.contains("on"));
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("a failed save keeps the bar, the server message and the changes", async () => {
  const { page, errors, close } = await open({ saveChurch: () => { throw new Error("permission denied for church 1043"); } });
  try {
    await addTime(page, "Szerda", "20:15");
    await page.locator("#save").click();
    await page.locator("#saveerr:not([hidden])").waitFor();
    assert.match(await page.locator("#saveerr").textContent(), /permission denied for church 1043/);
    assert.equal(await page.locator("#savebar.on").count(), 1);
    assert.equal((await page.locator("#savestate").textContent()).trim(), "1 nem mentett változás");
    assert.equal(await day(page, "Szerda").locator(".se-tile b", { hasText: "20:15" }).count(), 1, "the new time is kept");
    assert.equal(await page.locator("#toast.on").count(), 0);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("phone: #mode switches to the 7-day preview and back", async () => {
  const { page, errors, close } = await open();
  try {
    const mode = page.locator("#mode");
    assert.ok(await mode.isVisible());
    assert.ok(!(await page.locator("#preview").isVisible()), "preview hidden while editing");
    await mode.getByRole("button", { name: "Így látják a hívek" }).click();
    const rows = page.locator("#preview .pv-row");
    await rows.first().waitFor();
    assert.equal(await rows.count(), 7);
    assert.ok(!(await page.locator(".se-board").isVisible()), "board hidden in the preview");
    assert.match(await rows.nth(0).textContent(), /Hétfő.*nov\. 9\..*07:00 · 18:00 mise/);
    await mode.getByRole("button", { name: "Szerkesztés" }).click();
    assert.ok(await page.locator(".se-board").isVisible());
    assert.ok(!(await page.locator("#preview").isVisible()));
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("phone: Előnézet in the save bar opens the preview", async () => {
  const { page, close } = await open();
  try {
    await addTime(page, "Kedd", "19:30");
    await page.locator("#savebar.on").waitFor();
    await page.locator("#pv-go").click();
    await page.locator("#preview .pv-row").first().waitFor();
    assert.match(await page.locator("#preview .pv-row").nth(1).textContent(), /Kedd.*19:30/);
  } finally { await close(); }
});

test("sign-in screen uses the shared field and button parts", async () => {
  const { page, errors, close } = await open({ signedIn: false });
  try {
    await page.locator("#auth").waitFor({ timeout: 15000 });
    assert.equal(await page.locator('#auth .ui-field input[type="email"]').count(), 1);
    assert.equal(await page.locator('#auth .ui-field input[type="password"]').count(), 1);
    assert.equal(await page.locator("#auth .ui-btn.primary").count(), 1);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("laptop: preview column beside the editor, no #mode switch", async () => {
  const { page, errors, close } = await open({ view: LAPTOP });
  try {
    assert.ok(await page.locator("#preview").isVisible());
    assert.equal(await page.locator("#preview .pv-row").count(), 7);
    assert.ok(!(await page.locator("#mode").isVisible()));
    const board = await page.locator(".se-board").boundingBox(), pv = await page.locator("#preview").boundingBox();
    assert.ok(pv.x > board.x + board.width - 1, "preview is to the right of the board");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

// The editors' signature move: changed and not yet saved = amber (the card, the time, the tab's dot, the bar).
const settled = page => page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => { }))));
test("unsaved changes are amber until saved: the time and its day, a card, the tabs, the bar", async () => {
  const { page, errors, close } = await open();
  try {
    assert.equal(await page.locator("#main .chg, #top .chg").count(), 0, "nothing amber when opened");
    await addTime(page, "Kedd", "19:30");
    await page.locator("#savebar.on").waitFor(); await settled(page);
    assert.equal(await page.locator("#savebar").evaluate(b => getComputedStyle(b).backgroundColor), "rgb(255, 183, 3)", "the bar is amber");
    assert.equal(await day(page, "Kedd").locator(".se-tile.chg", { hasText: "19:30" }).count(), 1);
    assert.ok(await day(page, "Kedd").evaluate(e => e.classList.contains("chg")));
    assert.deepEqual(await page.locator(".pp-tabs .ui-tab.chg").allTextContents(), ["Heti rend"], "the section's tab has the dot");
    assert.equal(await page.locator('.ui-tab[data-sec="week"]').getAttribute("aria-describedby"), "pp-chg");
    assert.match(await page.locator("#preview").textContent(), /nem mentett változásokkal/, "the preview says it shows them");
    // A card: the phone number; undoing every change takes the amber and the bar away.
    await page.locator('.ui-tab[data-sec="data"]').click();
    await page.locator('[data-k="phone"]').fill("+36 36 999 999");
    assert.ok(await page.locator('[data-chg="contact"]').evaluate(e => e.classList.contains("chg")), "Elérhetőség is marked");
    assert.deepEqual(await page.locator(".pp-tabs .ui-tab.chg").allTextContents(), ["Heti rend", "Adatok"]);
    await page.locator('[data-k="phone"]').fill("+36 36 123 456");
    assert.ok(!(await page.locator('[data-chg="contact"]').evaluate(e => e.classList.contains("chg"))), "undone");
    await page.locator('.ui-tab[data-sec="week"]').click();
    // Saved: the amber fades, the bar goes, the toast says so.
    await page.locator("#save").click();
    await page.locator("#toast.on").waitFor();
    await page.waitForFunction(() => !document.querySelector("#main .chg, #top .chg") && !document.querySelector("#savebar").classList.contains("on"));
    await page.locator(".se-day").first().waitFor();
    assert.equal(await page.locator(".se-tile.chg").count(), 0);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("undoing the only change hides the save bar", async () => {
  const { page, close } = await open();
  try {
    await addTime(page, "Kedd", "19:30");
    await page.locator("#savebar.on").waitFor();
    await day(page, "Kedd").locator(".se-tile", { hasText: "19:30" }).click();
    const sheet = page.locator("dialog.se-sheet");
    await sheet.locator('[data-act="del"]').click(); await sheet.locator('[data-act="del"]').click();
    await sheet.waitFor({ state: "hidden" });
    await page.waitForFunction(() => !document.querySelector("#savebar").classList.contains("on"));
    assert.equal(await page.locator("#main .chg, #top .chg").count(), 0);
  } finally { await close(); }
});

test("the header is the navy board; the sections are a bottom tab bar with icons on a phone", async () => {
  const { page, close } = await open();
  try {
    assert.equal(await page.locator("#top").evaluate(e => getComputedStyle(e).backgroundColor), "rgb(19, 35, 63)");
    const bar = await page.locator(".pp-tabs").boundingBox(), vh = page.viewportSize().height;
    assert.ok(Math.abs(bar.y + bar.height - vh) < 1, "fixed to the bottom");
    assert.equal(await page.locator(".pp-tabs .ui-tab svg").count(), 4, "a line icon per section");
    assert.equal(await page.locator(".pp-kicker").count(), 0, "no eyebrow over the name");
  } finally { await close(); }
});
