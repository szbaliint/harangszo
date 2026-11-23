// A church's own feasts (its búcsú; churches.own_feasts, migration 015): added, edited and removed in the admin's
// Ünnepek tab and in the parish portal, saved through save_church, and shown on the map on their day with their times.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium, devices } from "./helpers/playwright.mjs";
import { startServer } from "./helpers/server.mjs";
import { mockSupabase } from "./helpers/supabase-mock.mjs";

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const { defaultBrowserType: _, ...IPHONE } = devices["iPhone 13"];
const LAPTOP = { viewport: { width: 1440, height: 900 } };
// A Monday morning in Budapest (admin and portal).
const NOW = new Date("2026-11-09T09:00:00+01:00");

let server, browser;
before(async () => { server = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.stop(); });

async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("timed out waiting for " + what); await new Promise(r => setTimeout(r, 25)); }
}
const saveCall = calls => calls.filter(c => c.path === "/rest/v1/rpc/save_church").at(-1);
const ANNA = { key: "own_1", name: "Szent Anna búcsú", md: "07-26" };
// The fixture church with own feasts: own_1 with its own time, own_2 with the Sunday order.
const withOwn = () => {
  const c = fixture("church-1043.json");
  c.own_feasts = [{ ...ANNA }, { key: "own_2", name: "Templomszentelés", md: "10-03" }];
  c.feast_sunday = ["jan6", "own_2"];
  c.services.push({ ...c.services[7], id: 9009, start_time: "09:00:00", note: "Búcsúi szentmise", feast: "own_1", tags: null });
  return c;
};

/* ---------- Admin ---------- */
async function openAdmin(church = fixture("church-1043.json")) {
  const context = await browser.newContext({ ...LAPTOP, timezoneId: "Europe/Budapest" });
  const page = await context.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  const admin = fixture("staff-admin.json");
  const row = { id: church.id, name: church.name, city: church.city, published: true, n_services: 7, has_confession: true, has_rorate: false, has_feast: true, n_pending: 0,
    importance: 60, importance_manual: null, from_osm: true, location_approx: false, schedule_source: null, schedule_locked: true, near_duplicate: false, created_by: null };
  const { calls } = await mockSupabase(page, { user: admin.user, staff: admin.staff,
    tables: { churches: [church], admin_church_list: [row], suggestions: [], access_requests: [], parish_editors: [], church_edits: [] },
    rpc: { save_church: () => church.id } });
  await page.clock.setFixedTime(NOW);
  await page.goto(`${server.url}/admin.html`);
  await page.locator("#clist .ad-it").first().click({ timeout: 15000 });
  await page.locator(".se-day").first().waitFor();
  await page.locator('.ad-tab[data-ctab="feasts"]').click();
  await page.locator("#own-new").waitFor();
  return { page, calls, errors, close: () => context.close() };
}
const adminCard = (page, key) => page.locator(`.ad-card[aria-labelledby="fh-${key}"]`);

test("admin: adds an own feast with its own times; save_church gets own_feasts and the rows", async () => {
  const { page, calls, errors, close } = await openAdmin();
  try {
    assert.equal(await page.locator(".ad-card", { hasText: "Saját ünnep hozzáadása" }).locator(".ad-muted").textContent(),
      "Például a templom búcsúja vagy védőszentjének ünnepe. Minden évben ugyanazon a napon.");
    // No name: nothing is added, the field says so.
    await page.locator("#add-own-btn").click();
    assert.equal(await page.locator("#own-new").evaluate(e => e.closest(".ui-field").classList.contains("err")), true);
    assert.equal(await adminCard(page, "own_1").count(), 0);
    await page.locator("#own-new").fill("Szent Anna búcsú");
    await page.locator("#own-new-m").selectOption("7");
    assert.equal(await page.locator("#own-new-d option").count(), 31);
    await page.locator("#own-new-d").selectOption("26");
    await page.locator("#add-own-btn").click();
    const card = adminCard(page, "own_1");
    await card.waitFor();
    assert.equal(await card.locator("h3").textContent(), "Szent Anna búcsú");
    assert.equal(await card.locator(".ad-when").textContent(), "2027. július 26., hétfő");
    // Own feasts first, then the built-in ones the church uses.
    assert.deepEqual((await page.locator(".ad-card h3").allTextContents()).slice(0, 3), ["Szent Anna búcsú", "Vízkereszt", "Nagyboldogasszony"]);
    assert.equal(await card.locator('[data-feastmode="own_1"][data-v="sunday"]').getAttribute("aria-pressed"), "true", "Sunday order to start with");
    await card.getByRole("button", { name: "Egyedi időpontok" }).click();
    await card.locator('input[data-feast="own_1"][data-f="start"]').fill("10:00");
    await card.locator('input[data-feast="own_1"][data-f="note"]').fill("Búcsúi szentmise");
    await card.getByRole("button", { name: "＋ Időpont" }).click();
    await card.locator('select[data-feast="own_1"][data-i="1"][data-f="kind"]').selectOption("confession");
    await card.locator('input[data-feast="own_1"][data-i="1"][data-f="start"]').fill("08:30");
    await card.locator('input[data-feast="own_1"][data-i="1"][data-f="end"]').fill("09:45");
    await page.locator("#save").click();
    await page.locator("#toast.on").waitFor();
    const p = saveCall(calls).body.p;
    assert.deepEqual(p.own_feasts, [ANNA]);
    assert.deepEqual(p.feast_sunday, ["jan6"]);
    assert.deepEqual(p.services.filter(s => s.feast === "own_1").map(s => [s.kind, s.start, s.end, s.note, JSON.stringify(s.days)]),
      [["mass", "10:00", "", "Búcsúi szentmise", "[]"], ["confession", "08:30", "09:45", "", "[]"]]);
    assert.ok(p.services.some(s => s.feast === "aug15"), "the built-in feast's row is still there");
    assert.deepEqual(Object.keys(p).slice(12, 14), ["feast_sunday", "own_feasts"]);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("admin: an own feast from the database — rename, move to 29 February, remove another, an empty name stops the save", async () => {
  const { page, calls, errors, close } = await openAdmin(withOwn());
  try {
    const a = adminCard(page, "own_1"), b = adminCard(page, "own_2");
    assert.equal(await a.locator('[data-feastmode="own_1"][data-v="custom"]').getAttribute("aria-pressed"), "true");
    assert.equal(await a.locator('input[data-feast="own_1"][data-f="start"]').inputValue(), "09:00");
    assert.equal(await b.locator('[data-feastmode="own_2"][data-v="sunday"]').getAttribute("aria-pressed"), "true");
    assert.equal(await b.locator(".ad-when").textContent(), "2027. október 3., vasárnap");
    // The title follows the name as it is typed.
    await b.locator('input[data-own="own_2"][data-f="name"]').fill("Templomszentelés évfordulója");
    assert.equal(await b.locator("h3").textContent(), "Templomszentelés évfordulója");
    // 31 July → February: the day becomes 29, held in leap years only.
    await a.locator('select[data-own="own_1"][data-f="d"]').selectOption("31");
    await a.locator('select[data-own="own_1"][data-f="m"]').selectOption("2");
    await page.waitForFunction(() => document.querySelector('[aria-labelledby="fh-own_1"] .ad-when')?.textContent.includes("február"));
    assert.equal(await adminCard(page, "own_1").locator(".ad-when").textContent(), "2028. február 29., kedd · csak szökőévben");
    assert.equal(await adminCard(page, "own_1").locator('select[data-own="own_1"][data-f="d"]').inputValue(), "29");
    await adminCard(page, "own_2").getByRole("button", { name: "Ünnep eltávolítása" }).click();
    assert.equal(await adminCard(page, "own_2").count(), 0);
    // An own feast needs a name.
    await adminCard(page, "own_1").locator('input[data-own="own_1"][data-f="name"]').fill("  ");
    await page.locator("#save").click();
    await page.locator("#saveerr:not([hidden])").waitFor();
    assert.equal(await page.locator("#saveerr").textContent(), "Saját ünnep: add meg a nevét.");
    assert.equal(saveCall(calls), undefined);
    await adminCard(page, "own_1").locator('input[data-own="own_1"][data-f="name"]').fill(" Szent Anna búcsú ");
    await page.locator("#save").click();
    await page.locator("#toast.on").waitFor();
    const p = saveCall(calls).body.p;
    assert.deepEqual(p.own_feasts, [{ key: "own_1", name: "Szent Anna búcsú", md: "02-29" }]);
    assert.deepEqual(p.feast_sunday, ["jan6"], "own_2's Sunday order went with it");
    assert.deepEqual(p.services.filter(s => s.feast === "own_1").map(s => s.start), ["09:00"]);
    assert.ok(!p.services.some(s => s.feast === "own_2"));
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("admin: ten own feasts are the most", async () => {
  const c = fixture("church-1043.json");
  c.own_feasts = Array.from({ length: 10 }, (_, i) => ({ key: "own_" + (i + 1), name: "Ünnep " + (i + 1), md: "05-" + String(i + 10) }));
  c.feast_sunday = [...c.feast_sunday, ...c.own_feasts.map(f => f.key)];
  const { page, errors, close } = await openAdmin(c);
  try {
    assert.equal(await page.locator(".ad-card[aria-labelledby^='fh-own_']").count(), 10);
    assert.equal(await page.locator("#add-own-btn").isDisabled(), true);
    assert.equal(await page.locator(".ad-card", { hasText: "Saját ünnep hozzáadása" }).locator(".ad-muted").textContent(), "Legfeljebb 10 saját ünnepet vehetsz fel.");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

/* ---------- Parish portal ---------- */
async function openPortal(church = fixture("church-1043.json"), view = LAPTOP) {
  const context = await browser.newContext({ ...view, timezoneId: "Europe/Budapest" });
  const page = await context.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  const parish = fixture("staff-parish.json");
  const { calls } = await mockSupabase(page, { user: parish.user, staff: parish.staff,
    tables: { staff_churches: parish.staff_churches, churches: [church] }, rpc: { save_church: () => 1043 } });
  await page.clock.setFixedTime(NOW);
  await page.goto(`${server.url}/plebania.html`);
  await page.locator(".se-day").first().waitFor({ timeout: 15000 });
  await page.locator('.ui-tab[data-sec="feasts"]').click();
  await page.locator("#of-name").waitFor();
  return { page, calls, errors, close: () => context.close() };
}
const ppCard = (page, key) => page.locator(`.pp-card[aria-labelledby="fh-${key}"]`);
const pvRow = (page, text) => page.locator("#preview .pv-row", { hasText: text });

test("portal: adds an own feast, gives it times; the preview names it on its day; Mentés sends it", async () => {
  const { page, calls, errors, close } = await openPortal();
  try {
    await page.locator("#of-name").fill("Szent Márton búcsú");
    await page.locator('[data-ofnew][data-f="m"]').selectOption("11");
    await page.locator('[data-ofnew][data-f="d"]').selectOption("11");
    await page.getByRole("button", { name: "＋ Saját ünnep" }).click();
    const card = ppCard(page, "own_1");
    await card.waitFor();
    assert.equal(await card.locator(".when").textContent(), "2026. nov. 11., szerda");
    // First in the list, before the add card and the calendar's feasts; two choices only.
    assert.deepEqual((await page.locator(".pp-card h3").allTextContents()).slice(0, 3), ["Szent Márton búcsú", "Saját ünnep hozzáadása", "Parancsolt ünnepeken"]);
    assert.deepEqual(await card.locator(".ui-seg button").allTextContents(), ["Vasárnapi rend", "Saját idők"]);
    assert.equal(await card.getByRole("button", { name: "Vasárnapi rend" }).getAttribute("aria-pressed"), "true");
    // Wednesday 11 November: the Sunday times, named.
    assert.match(await pvRow(page, "nov. 11.").textContent(), /08:00 · 10:00 · 18:00 mise.*Szent Márton búcsú · vasárnapi rend/);
    await card.getByRole("button", { name: "Saját idők" }).click();
    await card.locator('input[data-f="start"]').fill("10:30");
    assert.match(await pvRow(page, "nov. 11.").textContent(), /^Szerda\s*nov\. 11\.\s*10:30 mise\s*Szent Márton búcsú$/);
    assert.match(await pvRow(page, "nov. 12.").textContent(), /07:00 · 18:00 mise$/, "the next day is as usual");
    await page.locator("#save").click();
    await page.locator("#toast.on").waitFor();
    const p = saveCall(calls).body.p;
    assert.deepEqual(p.own_feasts, [{ key: "own_1", name: "Szent Márton búcsú", md: "11-11" }]);
    assert.deepEqual(p.feast_sunday, ["jan6"]);
    assert.deepEqual(p.services.filter(s => s.feast === "own_1").map(s => [s.kind, s.start, JSON.stringify(s.days)]), [["mass", "10:30", "[]"]]);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("portal: an own feast from the database — rename, its times need one row, remove", async () => {
  const c = withOwn();
  c.own_feasts[0].md = "11-10"; // Tuesday in the preview's week
  const { page, calls, errors, close } = await openPortal(c, IPHONE);
  try {
    const a = ppCard(page, "own_1");
    assert.equal(await a.getByRole("button", { name: "Saját idők" }).getAttribute("aria-pressed"), "true");
    assert.equal(await ppCard(page, "own_2").getByRole("button", { name: "Vasárnapi rend" }).getAttribute("aria-pressed"), "true");
    await a.locator('input[data-of="own_1"][data-f="name"]').fill("Szent Anna és Joakim búcsú");
    assert.equal(await a.locator("h3").textContent(), "Szent Anna és Joakim búcsú");
    // Deleting its only time keeps "Saját idők": saving asks for a time.
    await a.getByRole("button", { name: "Időpont törlése" }).click();
    assert.equal(await ppCard(page, "own_1").getByRole("button", { name: "Saját idők" }).getAttribute("aria-pressed"), "true");
    await page.locator("#save").click();
    await page.locator("#saveerr:not([hidden])").waitFor();
    assert.equal(await page.locator("#saveerr").textContent(), "Szent Anna és Joakim búcsú: adj meg legalább egy időpontot, vagy válaszd a vasárnapi rendet.");
    await ppCard(page, "own_1").getByRole("button", { name: "Vasárnapi rend" }).click();
    await ppCard(page, "own_2").getByRole("button", { name: "Ünnep eltávolítása" }).click();
    assert.equal(await ppCard(page, "own_2").count(), 0);
    await page.locator("#save").click();
    await page.locator("#toast.on").waitFor();
    const p = saveCall(calls).body.p;
    assert.deepEqual(p.own_feasts, [{ key: "own_1", name: "Szent Anna és Joakim búcsú", md: "11-10" }]);
    assert.deepEqual(p.feast_sunday.sort(), ["jan6", "own_1"]);
    assert.ok(!p.services.some(s => /^own_/.test(s.feast || "")));
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

/* ---------- The map ---------- */
// Monday 26 July 2027, 08:00: Szent Anna's búcsú with its own times at the nearest church; a búcsú in the Sunday order
// at the next one.
const FEAST_DAY = new Date("2027-07-26T08:00:00+02:00");
const mapData = () => [
  { id: 301, name: "Szent Anna-templom", city: "Budapest", address: "Szentháromság tér 2.", rite: "rk", lat: 47.502, lon: 19.0344, imp: 90,
    own_feasts: [{ ...ANNA }],
    services: [{ kind: "mass", days: [1, 2, 3, 4, 5], start: "18:00" }, { kind: "mass", days: [0], start: "10:00" },
      { kind: "mass", days: [], start: "09:00", feast: "own_1", note: "Búcsúi szentmise" }, { kind: "mass", days: [], start: "11:00", feast: "own_1" }] },
  { id: 302, name: "Joakim-kápolna", city: "Budapest", address: "Batthyány tér 7.", rite: "rk", lat: 47.5065, lon: 19.0385, imp: 80,
    own_feasts: [{ key: "own_1", name: "Templombúcsú", md: "07-26" }], feast_sunday: ["own_1"],
    services: [{ kind: "mass", days: [1], start: "19:00" }, { kind: "mass", days: [0], start: "10:30" }] },
];
async function openMap(now = FEAST_DAY, data = mapData()) {
  const context = await browser.newContext({ ...IPHONE, timezoneId: "Europe/Budapest", serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await mockSupabase(page, { rpc: { public_data: () => data, track: () => null } });
  await page.clock.setFixedTime(now);
  await page.goto(server.url + "/index.html");
  await page.locator("#m-name").waitFor({ timeout: 15000 });
  return { page, errors, close: () => context.close() };
}

test("map: on its day the own feast's times replace the regular ones, with its name", async () => {
  const { page, errors, close } = await openMap();
  try {
    // Most: the búcsú's 09:00, not the weekday 18:00; then the Sunday-order church's 10:30 and the 11:00.
    assert.equal(await page.locator("#m-name").textContent(), "Szent Anna-templom");
    assert.equal(await page.locator("#m-when .big").textContent(), "09:00");
    assert.match(await page.locator("#m-when .when-side span").textContent(), /^Búcsúi szentmise/);
    const rows = await page.$$eval(".most .rows .row", els => els.map(e => [e.querySelector(".r-t").textContent, e.querySelector(".r-name").textContent]));
    assert.deepEqual(rows, [["10:30", "Joakim-kápolna"], ["11:00", "Szent Anna-templom"]]);
    // The church page: the feast line and that day's times.
    await page.click("#m-week");
    await page.locator('.detail[data-id="301"]').waitFor();
    assert.equal(await page.locator(".d-feast").textContent(), "Ünnepi miserend · Szent Anna búcsú");
    assert.deepEqual(await page.$$eval("#d-day .d-row .d-t", els => els.map(e => e.textContent)), ["09:00", "11:00"]);
    assert.match(await page.locator("#f-feasts").textContent(), /26\s*júl\.\s*Szent Anna búcsú\s*Hétfő\s*09:00 mise \(Búcsúi szentmise\) · 11:00 mise/);
    // The next day is an ordinary Tuesday.
    await page.click('.d-days button[data-off="1"]');
    assert.equal(await page.locator(".d-feast").count(), 0);
    assert.deepEqual(await page.$$eval("#d-day .d-row .d-t", els => els.map(e => e.textContent)), ["18:00"]);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("map: an own feast in the Sunday order shows the Sunday times, named", async () => {
  const { page, errors, close } = await openMap();
  try {
    await page.click('.most .rows .row[data-id="302"]');
    await page.locator('.detail[data-id="302"]').waitFor();
    assert.equal(await page.locator(".d-feast").textContent(), "Ünnepi miserend · Templombúcsú (vasárnapi rend szerint)");
    assert.deepEqual(await page.$$eval("#d-day .d-row .d-t", els => els.map(e => e.textContent)), ["10:30"]);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("map: the own feast comes before a built-in feast on the same day; a 29 February feast is not shown in other years", async () => {
  const data = mapData();
  data[0].own_feasts.push({ key: "own_2", name: "Nagyboldogasszony búcsú", md: "08-15" }, { key: "own_3", name: "Szökőnapi ünnep", md: "02-29" });
  data[0].services.push({ kind: "mass", days: [], start: "08:00", feast: "own_2" }, { kind: "mass", days: [], start: "12:00", feast: "aug15" },
    { kind: "mass", days: [], start: "07:00", feast: "own_3" });
  data[1].services.push({ kind: "mass", days: [], start: "12:30", feast: "aug15" });
  const { page, errors, close } = await openMap(FEAST_DAY, data);
  try {
    const got = await page.evaluate(() => {
      const di = (id, y, m, d) => { const x = dayInfo(BY_ID.get(id), dayContext(new Date(y, m - 1, d))); return [x.feast, x.feastMode, x.items.map(i => i.t).join(" ")]; };
      return { own: di(301, 2027, 8, 15), sundayOwn: di(302, 2027, 7, 26), builtin: di(302, 2027, 8, 15), leap: di(301, 2028, 2, 29), noLeap: di(301, 2027, 3, 1), noLeap28: di(301, 2027, 2, 28) };
    });
    assert.deepEqual(got.own, ["Nagyboldogasszony búcsú", "custom", "08:00"], "the own feast's rows, not the built-in aug15 row");
    assert.deepEqual(got.sundayOwn, ["Templombúcsú", "sunday", "10:30"]);
    assert.deepEqual(got.builtin, ["Nagyboldogasszony", "custom", "12:30"], "without an own feast the built-in feast is as before");
    assert.deepEqual(got.leap, ["Szökőnapi ünnep", "custom", "07:00"]);
    assert.deepEqual(got.noLeap, [null, null, "18:00"], "1 March 2027 (a Monday) has no feast: the weekday times");
    assert.deepEqual(got.noLeap28, [null, null, "10:00"], "28 February 2027 is a plain Sunday");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});
