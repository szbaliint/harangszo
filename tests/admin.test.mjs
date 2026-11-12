// Task 7: the admin — rail, church list with chips and tags, the church with its tabs, the shared week board with
// the Haladó fold, side boxes (suggestions, admin-only fields, editors), save bar, phone stacking.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "./helpers/playwright.mjs";
import { startServer } from "./helpers/server.mjs";
import { mockSupabase, SUPABASE_URL } from "./helpers/supabase-mock.mjs";

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const LAPTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };
// A Monday morning in Budapest.
const NOW = new Date("2026-11-09T09:00:00+01:00");

let server, browser;
before(async () => { server = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.stop(); });

// Three churches: the fixture (parish-managed, two suggestions), one without times, one imported and hidden.
function adminData() {
  const church = fixture("church-1043.json");
  const imported = { ...fixture("church-1043.json"), id: 1045, name: "Minorita templom", schedule_source: "miserend", source_ref: "2211", schedule_locked: false,
    schedule_updated: "2026-10-01", published: false, created_by: "miserend", events: [], services: fixture("church-1043.json").services.map(s => ({ ...s, church_id: 1045 })) };
  const other = { id: 1044, name: "Ciszterci templom", city: "Eger", address: "Széchenyi utca 15.", lat: 47.9008, lon: 20.3765, published: true };
  const row = (c, x) => ({ id: c.id, name: c.name, city: c.city, published: c.published, n_services: 7, has_confession: true, has_rorate: false, has_feast: true, n_pending: 0,
    importance: 60, importance_manual: null, from_osm: true, location_approx: false, schedule_source: null, schedule_locked: true, near_duplicate: false, created_by: null, ...x });
  return {
    church, imported,
    tables: {
      churches: [church, other, imported],
      admin_church_list: [row(church, { n_pending: 2 }), row(other, { n_services: 0, has_confession: false, has_feast: false, location_approx: true }),
        row(imported, { schedule_source: "miserend", schedule_locked: false, published: false })],
      suggestions: [
        { id: 5001, church_id: 1043, type: "mass", text: "Kedden 18:00 helyett 18:30 van a mise novembertől.", contact: null, status: "pending", created_at: "2026-11-06T10:00:00+01:00", churches: { id: 1043, name: church.name, city: church.city } },
        { id: 5002, church_id: 1043, type: "conf", text: "Pénteken a gyóntatás fél ötkor kezdődik.", contact: "anna@example.org", status: "pending", created_at: "2026-11-08T18:00:00+01:00", churches: { id: 1043, name: church.name, city: church.city } }],
      access_requests: [{ id: 801, church_id: 1043, user_id: "00000000-0000-4000-8000-000000000001", name: "Kiss Péter", position: "irodavezető", email: "iroda@example.org", phone: null, message: null, status: "pending", created_at: "2026-11-07T09:00:00+01:00", churches: { id: 1043, name: church.name, city: church.city } }],
      parish_editors: [{ church_id: 1043, user_id: "00000000-0000-4000-8000-000000000001", role: "parish", display_name: "Szent Anna plébánia", email: "plebania@example.org" }],
      church_edits: [
        { church_id: 1043, user_id: "00000000-0000-4000-8000-000000000001", who: "Szent Anna plébánia", at: "2026-11-08T21:14:00+01:00" },
        { church_id: 1043, user_id: "00000000-0000-4000-8000-0000000000a1", who: "Bálint", at: "2026-10-20T10:15:00+02:00" }],
    },
  };
}

async function openAdmin({ view = LAPTOP, rpc = {}, colorScheme = "light", staff, user } = {}) {
  const context = await browser.newContext({ ...view, timezoneId: "Europe/Budapest", colorScheme });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  const admin = fixture("staff-admin.json"), d = adminData();
  const { calls } = await mockSupabase(page, {
    user: user || admin.user, staff: staff || admin.staff, tables: d.tables,
    rpc: { save_church: () => 1043, approve_access: () => null, merge_churches: b => b.keep_id, ...rpc },
  });
  // The shared mock answers counts without exposing content-range to the page (CORS), so supabase-js reads them as
  // null; the rail's counts (HEAD requests) are answered here with the header exposed.
  await page.route(`${SUPABASE_URL}/rest/v1/**`, route => {
    const req = route.request();
    if (req.method() !== "HEAD") return route.fallback();
    const url = new URL(req.url());
    let rows = d.tables[url.pathname.slice("/rest/v1/".length)] || [];
    for (const [k, v] of url.searchParams) if (v.startsWith("eq.")) rows = rows.filter(r => !(k in r) || String(r[k]) === v.slice(3));
    return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-expose-headers": "content-range",
      "content-range": rows.length ? `0-${rows.length - 1}/${rows.length}` : "*/0" } });
  });
  await page.clock.setFixedTime(NOW);
  await page.goto(`${server.url}/admin.html`);
  if (!staff || staff.role === "admin") await page.locator("#clist .ad-it").first().waitFor({ timeout: 15000 });
  return { page, calls, errors, d, close: () => context.close() };
}
const item = (page, name) => page.locator("#clist .ad-it", { hasText: name });
async function openChurch(page, name) {
  await item(page, name).click();
  await page.locator(".se-day").first().waitFor();
}
const day = (page, name) => page.locator(".se-day", { has: page.getByText(name, { exact: true }) });
const sheet = page => page.locator("dialog.se-sheet");
const saves = calls => calls.filter(c => c.path === "/rest/v1/rpc/save_church");
const saveCall = calls => saves(calls).at(-1);
const patches = calls => calls.filter(c => c.path === "/rest/v1/suggestions" && c.method === "PATCH");
// Waits for a condition on the recorded requests (node side).
async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("timed out waiting for " + what); await new Promise(r => setTimeout(r, 25)); }
}

test("rail: badges and count; list: tags; three columns at 1440", async () => {
  const { page, errors, close } = await openAdmin();
  try {
    await page.locator("#sugg-count:not(:empty)").waitFor();
    assert.equal((await page.locator("#sugg-count").textContent()).trim(), "2");
    assert.equal((await page.locator("#access-count").textContent()).trim(), "1");
    assert.equal((await page.locator("#n-churches").textContent()).trim(), "3");
    assert.deepEqual((await page.locator("#rail [data-page] > span:first-child").allTextContents()), ["Templomok", "Javaslatok", "Hozzáférések", "Összevonás", "Statisztika"]);
    assert.equal(await page.locator("#clist .ad-it").count(), 3);
    assert.equal((await page.locator("#ccount").textContent()).trim(), "3 találat");
    await item(page, "Szent Anna").locator(".ui-tag", { hasText: "plébánia kezeli" }).waitFor();
    assert.equal(await item(page, "Szent Anna").locator(".ui-tag.t-conf", { hasText: "2 javaslat" }).count(), 1);
    assert.equal(await item(page, "Ciszterci").locator(".ui-tag.t-warn", { hasText: "nincs időpont" }).count(), 1);
    assert.equal(await item(page, "Ciszterci").locator(".ui-tag.t-warn", { hasText: "hely bizonytalan" }).count(), 1);
    assert.equal(await item(page, "Minorita").locator(".ui-tag.t-muted", { hasText: "miserend.hu" }).count(), 1);
    assert.equal(await item(page, "Minorita").locator(".ui-tag.t-muted", { hasText: "rejtett" }).count(), 1);
    const [r, l, m] = await Promise.all(["#rail", "#listcol", "#main"].map(s => page.locator(s).boundingBox()));
    assert.ok(Math.abs(r.width - 200) < 1 && Math.abs(l.width - 330) < 1, `rail ${r.width}, list ${l.width}`);
    assert.ok(r.x < l.x && l.x < m.x && Math.abs(r.y - l.y) < 1 && Math.abs(l.y - m.y) < 1, "side by side");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("filter chips and the Szűrők sheet drive the list query", async () => {
  const { page, calls, close } = await openAdmin();
  try {
    const before = calls.length;
    await page.locator("#chips .ui-chip", { hasText: "Nincs időpont" }).click();
    assert.equal(await page.locator("#chips .ui-chip", { hasText: "Nincs időpont" }).getAttribute("aria-pressed"), "true");
    await page.waitForFunction(() => document.querySelector("#open-filters .ad-fbadge")?.textContent === "1");
    await until(() => calls.slice(before).some(c => c.path === "/rest/v1/admin_church_list" && /n_services=eq\.0/.test(c.query)), "times=no filter");
    await page.locator("#open-filters").click();
    await page.locator("#fsheet").waitFor({ state: "visible" });
    await page.locator("#f-vis").selectOption("hidden");
    await page.waitForFunction(() => document.querySelector("#open-filters .ad-fbadge")?.textContent === "2");
    await until(() => calls.some(c => c.path === "/rest/v1/admin_church_list" && /published=eq\.false/.test(c.query)), "vis=hidden filter");
    await page.locator("#clear-filters").click();
    await page.waitForFunction(() => !document.querySelector("#open-filters .ad-fbadge"));
    await page.locator("#fsheet").getByRole("button", { name: "Kész" }).last().click();
    await page.locator("#fsheet").waitFor({ state: "hidden" });
    // A number searches the id too.
    await page.locator("#cq").fill("1043");
    await until(() => calls.some(c => c.path === "/rest/v1/admin_church_list" && /or=.*id\.eq\.1043/.test(decodeURIComponent(c.query))), "id search");
  } finally { await close(); }
});

test("clicking a church shows its header, tabs, the week board and the side boxes", async () => {
  const { page, errors, d, close } = await openAdmin();
  try {
    await openChurch(page, "Szent Anna");
    assert.equal((await page.locator("h1.ad-name").textContent()).trim(), d.church.name);
    assert.match(await page.locator("#ch-meta").textContent(), /Szent Anna utca 1\. · #1043 · utoljára mentette: Szent Anna plébánia, tegnap 21:14/);
    assert.equal(await item(page, "Szent Anna").getAttribute("aria-current"), "true");
    assert.deepEqual((await page.locator(".ad-tabs .ad-tab").allTextContents()).map(s => s.trim()), ["Miserend", "Ünnepek", "Események", "Adatok", "Szerkesztők", "Előzmények"]);
    assert.equal(await page.locator(".se-day").count(), 7);
    assert.deepEqual(await day(page, "Vasárnap").locator(".se-tile:not(.se-add) b").allTextContents(), ["08:00", "10:00", "18:00"]);
    assert.equal(await page.locator("#f-pub").isChecked(), true);
    assert.equal(await page.getByRole("link", { name: "Megnyitás a térképen" }).getAttribute("href"), "index.html#t=1043");
    assert.match(await page.locator("#side-sugg h2").textContent(), /Javaslat ehhez a templomhoz · 2/);
    assert.equal(await page.locator("#side-sugg").getByRole("button", { name: "Átveszem" }).count(), 2);
    assert.ok(await page.locator("#side-admin select[data-k=importance_manual]").isVisible());
    assert.equal(await page.locator("#side-admin #f-lock").isChecked(), true);
    assert.match(await page.locator("#side-editors").textContent(), /Szent Anna plébánia.*jóváhagyva.*Kiss Péter.*jóváhagyásra vár/s);
    // Side boxes sit to the right of the board.
    const board = await page.locator("#board").boundingBox(), side = await page.locator(".ad-side").boundingBox();
    assert.ok(side.x > board.x + board.width - 1 && Math.abs(side.width - 290) < 1, "side column beside the board");
    assert.equal(await page.locator("#savebar.on").count(), 0);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("Haladó: every 2 with an anchor ends up in the save_church payload", async () => {
  const { page, calls, errors, close } = await openAdmin();
  try {
    await openChurch(page, "Szent Anna");
    await day(page, "Hétfő").locator(".se-tile", { hasText: "07:00" }).click();
    await sheet(page).waitFor({ state: "visible" });
    await sheet(page).locator(".se-adv summary").click();
    await sheet(page).locator('input[data-buf="every"]').fill("2");
    await sheet(page).locator('input[data-buf="every"]').press("Tab");
    await sheet(page).locator('input[data-f="anchor"]').fill("2026-11-16");
    assert.match(await sheet(page).locator(".se-sum").textContent(), /kéthetente/);
    await sheet(page).locator("[data-act=save]").click();
    await sheet(page).waitFor({ state: "hidden" });
    await page.locator("#savebar.on").waitFor();
    assert.equal((await page.locator("#savestate").textContent()).trim(), "1 nem mentett változás");
    await page.locator("#save").click();
    await page.locator("#toast.on").waitFor();
    assert.equal((await page.locator("#toast").textContent()).trim(), "Mentve");
    const p = saveCall(calls).body.p;
    const r = p.services.find(s => s.kind === "mass" && s.start === "07:00" && !s.feast);
    assert.deepEqual({ days: r.days, every: r.every, anchor: r.anchor }, { days: [1, 2, 3, 4, 5], every: 2, anchor: "2026-11-16" });
    // The rest is the stored shape save() always sent: other rules, the feast row, the church fields.
    assert.ok(p.services.some(s => s.kind === "mass" && s.start === "18:00" && s.period === "school" && s.every === null && s.anchor === ""));
    assert.ok(p.services.some(s => s.kind === "adoration" && JSON.stringify(s.weeks) === "[1]" && s.end === "19:30" && JSON.stringify(s.tags) === "[]"));
    assert.ok(p.services.some(s => s.feast === "aug15" && s.start === "09:00" && JSON.stringify(s.days) === "[]"));
    assert.deepEqual(Object.keys(p), ["id", "name", "city", "address", "rite", "lat", "lon", "website", "phone", "notes", "open_only_services", "published",
      "feast_sunday", "importance_manual", "schedule_note", "location_approx", "schedule_locked", "hours", "services", "events"]);
    assert.deepEqual([p.id, p.feast_sunday, p.schedule_locked, p.importance_manual], [1043, ["jan6"], true, ""]);
    assert.deepEqual(p.hours, [{ days: [1, 2, 3, 4, 5, 6], opens: "08:00", closes: "18:00" }, { days: [0], opens: "07:00", closes: "20:00" }]);
    await page.waitForFunction(() => !document.querySelector("#savebar").classList.contains("on"));
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("published toggle and an admin-only field go into the payload", async () => {
  const { page, calls, close } = await openAdmin();
  try {
    await openChurch(page, "Szent Anna");
    await page.locator("#f-pub").uncheck();
    await page.locator("#f-imp").selectOption("75");
    await page.locator("#f-approx").check();
    await page.locator("#savebar.on").waitFor();
    assert.equal((await page.locator("#savestate").textContent()).trim(), "3 nem mentett változás");
    await page.locator("#bar-save").click();
    await page.locator("#toast.on").waitFor();
    const p = saveCall(calls).body.p;
    assert.deepEqual([p.published, p.importance_manual, p.location_approx], [false, 75, true]);
  } finally { await close(); }
});

test("auto-lock: hand-edited times of an imported church are locked, other edits are not", async () => {
  const { page, calls, close } = await openAdmin();
  try {
    await openChurch(page, "Minorita");
    assert.match(await page.locator("#side-admin").textContent(), /miserend\.hu.*#2211/s);
    assert.equal(await page.locator("#f-lock").isChecked(), false);
    // Only a detail changes: no lock.
    await page.locator(".ad-tab", { hasText: "Adatok" }).click();
    await page.locator("#f-phone").fill("+36 1 555 0000");
    await page.locator("#save").click();
    await page.locator("#toast.on").waitFor();
    assert.equal(saveCall(calls).body.p.schedule_locked, false);
    assert.equal((await page.locator("#toast").textContent()).trim(), "Mentve");
    // Opening a tile and saving it unchanged is no change either.
    await page.locator(".ad-tab", { hasText: "Miserend" }).click();
    await day(page, "Kedd").locator(".se-tile", { hasText: "07:00" }).click();
    await sheet(page).locator("[data-act=save]").click();
    await sheet(page).waitFor({ state: "hidden" });
    await page.locator("#save").click();
    await until(() => saves(calls).length === 2, "the second save");
    assert.equal(saveCall(calls).body.p.schedule_locked, false, "unchanged rules do not lock");
    // A real change to the times locks them.
    await page.getByRole("button", { name: "Időpont hozzáadása: Szombat" }).click();
    await sheet(page).locator(".se-start").fill("19:00");
    await sheet(page).getByRole("button", { name: "Hozzáadás" }).click();
    await sheet(page).waitFor({ state: "hidden" });
    await page.locator("#save").click();
    await page.waitForFunction(() => /zároltuk/.test(document.querySelector("#toast").textContent));
    assert.equal(saveCall(calls).body.p.schedule_locked, true);
    assert.equal(await page.locator("#f-lock").isChecked(), true);
  } finally { await close(); }
});

test("a failed save keeps the bar, the server message and the changes", async () => {
  const { page, close } = await openAdmin({ rpc: { save_church: () => { throw new Error("permission denied for church 1043"); } } });
  try {
    await openChurch(page, "Szent Anna");
    await page.getByRole("button", { name: "Időpont hozzáadása: Szerda" }).click();
    await sheet(page).locator(".se-start").fill("20:15");
    await sheet(page).getByRole("button", { name: "Hozzáadás" }).click();
    await page.locator("#bar-save").click();
    await page.locator("#saveerr:not([hidden])").waitFor();
    assert.match(await page.locator("#saveerr").textContent(), /permission denied for church 1043/);
    assert.equal(await page.locator("#savebar.on").count(), 1);
    assert.equal(await day(page, "Szerda").locator(".se-tile b", { hasText: "20:15" }).count(), 1);
    // A validation problem jumps to its tab and shows in the bar.
    await page.locator(".ad-tab", { hasText: "Adatok" }).click();
    await page.locator("#f-name").fill("");
    await page.locator(".ad-tab", { hasText: "Miserend" }).click();
    await page.locator("#save").click();
    await page.waitForFunction(() => /nevét/.test(document.querySelector("#saveerr").textContent));
    assert.equal(await page.locator(".ad-tab[aria-pressed=true]").textContent(), "Adatok");
  } finally { await close(); }
});

test("Átveszem in #side-sugg sends the same update as Elfogadás on the Javaslatok page", async () => {
  const { page, calls, errors, close } = await openAdmin();
  try {
    await openChurch(page, "Szent Anna");
    await page.locator("#side-sugg").getByRole("button", { name: "Átveszem" }).first().click();
    await page.waitForFunction(() => /· 1$/.test(document.querySelector("#side-sugg h2").textContent.trim()));
    const side = calls.find(c => c.path === "/rest/v1/suggestions" && c.method === "PATCH");
    assert.ok(side, "suggestion updated");
    assert.match(side.query, /id=eq\.5001/);
    await page.locator("#rail [data-page=sugg]").click();
    await page.locator("#slist .ad-sgcard").first().waitFor();
    assert.equal(await page.locator("#slist .ad-sgcard").count(), 2);
    await page.locator("#slist").getByRole("button", { name: "Elfogadás" }).nth(1).click();
    await until(() => patches(calls).length === 2, "the page's update");
    const pageCall = patches(calls).at(-1);
    assert.match(pageCall.query, /id=eq\.5002/);
    assert.deepEqual(Object.keys(side.body).sort(), Object.keys(pageCall.body).sort());
    assert.deepEqual([side.body.status, pageCall.body.status, side.body.decided_by], ["approved", "approved", "00000000-0000-4000-8000-0000000000a1"]);
    // Elutasítom → rejected
    await page.locator("#rail [data-page=churches]").click();
    await page.locator("#side-sugg").getByRole("button", { name: "Elutasítom" }).first().click();
    await page.waitForFunction(() => /· 0$/.test(document.querySelector("#side-sugg h2")?.textContent.trim() || ""));
    assert.equal(patches(calls).length, 3);
    assert.deepEqual([patches(calls).at(-1).body.status, patches(calls).at(-1).query], ["rejected", "?id=eq.5002"]);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("no row editor left: no .srow anywhere, on any tab", async () => {
  const src = readFileSync(new URL("../admin.js", import.meta.url), "utf8") + readFileSync(new URL("../admin.html", import.meta.url), "utf8");
  for (const old of ["srow", "serviceRow", "daysHTML"]) assert.ok(!src.includes(old), `${old} is gone`);
  const { page, errors, close } = await openAdmin();
  try {
    await openChurch(page, "Szent Anna");
    for (const t of ["Miserend", "Ünnepek", "Események", "Adatok", "Szerkesztők", "Előzmények"]) {
      await page.locator(".ad-tab", { hasText: t }).click();
      assert.equal(await page.locator(".srow").count(), 0, t);
    }
    assert.match(await page.locator(".ad-hist").textContent(), /Szent Anna plébánia.*Mentés a plébániai felületen.*Bálint/s);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("Új templom: starts on Adatok, saves with id null, then shows its id and all tabs", async () => {
  const { page, calls, errors, close } = await openAdmin({ rpc: { save_church: () => 1099 } });
  try {
    await page.locator("#new-church").click();
    assert.equal((await page.locator("h1.ad-name").textContent()).trim(), "Új templom");
    assert.equal(await page.locator(".ad-tab[aria-pressed=true]").textContent(), "Adatok");
    assert.equal(await page.locator(".ad-tab").count(), 4);
    await page.locator("#f-name").fill("Új kápolna");
    await page.locator("#f-city").fill("Eger");
    await page.locator("#f-lat").fill("47,9");
    await page.locator("#f-lon").fill("20.38");
    await page.locator("#bar-save").click();
    await page.locator("#toast.on").waitFor();
    const p = saveCall(calls).body.p;
    assert.deepEqual([p.id, p.name, p.lat, p.lon, p.published, p.services], [null, "Új kápolna", 47.9, 20.38, true, []]);
    await page.waitForFunction(() => document.querySelectorAll(".ad-tab").length === 6);
    assert.match(await page.locator("#ch-meta").textContent(), /#1099/);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("deleting a church asks first", async () => {
  const { page, calls, close } = await openAdmin();
  try {
    await openChurch(page, "Szent Anna");
    await page.locator(".ad-tab", { hasText: "Adatok" }).click();
    let asked = "";
    page.once("dialog", dlg => { asked = dlg.message(); dlg.dismiss(); });
    await page.locator("#del").click();
    await page.waitForTimeout(200);
    assert.match(asked, /Biztosan törlöd: Szent Anna-templom\?/);
    assert.equal(calls.filter(c => c.path === "/rest/v1/churches" && c.method === "DELETE").length, 0, "cancel keeps it");
    page.once("dialog", dlg => dlg.accept());
    await page.locator("#del").click();
    await page.locator(".ad-main .ui-empty").waitFor();
    const del = calls.find(c => c.path === "/rest/v1/churches" && c.method === "DELETE");
    assert.ok(del && /id=eq\.1043/.test(del.query));
  } finally { await close(); }
});

test("access requests and merge keep their RPCs", async () => {
  const { page, calls, close } = await openAdmin();
  try {
    await page.locator("#rail [data-page=access]").click();
    await page.locator("#alist .ad-sgcard").first().waitFor();
    await page.locator("#alist").getByRole("button", { name: "Jóváhagyás" }).click();
    await until(() => calls.some(c => c.path === "/rest/v1/rpc/approve_access"), "approve_access");
    const ap = calls.find(c => c.path === "/rest/v1/rpc/approve_access");
    assert.deepEqual(ap?.body, { req: 801 });
    await page.locator("#rail [data-page=merge]").click();
    await page.locator(".ad-main .ui-empty").waitFor();
    await item(page, "Szent Anna").click();
    await page.locator("#mlist .ad-it").first().waitFor();
    await page.locator("#mlist .ad-it", { hasText: "Ciszterci" }).click();
    await page.locator("#do-merge").click();
    await page.locator("#toast.on").waitFor();
    const m = calls.find(c => c.path === "/rest/v1/rpc/merge_churches");
    assert.deepEqual(m.body, { keep_id: 1043, drop_id: 1044, schedule_from: "keep", name_from: "keep" });
    assert.equal(await page.locator("#rail [data-page=churches]").getAttribute("aria-pressed"), "true");
  } finally { await close(); }
});

test("390×844: the rail, the list and the church stack", async () => {
  const { page, errors, close } = await openAdmin({ view: PHONE });
  try {
    const r = await page.locator("#rail").boundingBox(), l = await page.locator("#listcol").boundingBox();
    assert.ok(r.y + r.height <= l.y + 1, "rail above the list");
    assert.ok(Math.abs(l.x) < 1 && l.width > 380, "list full width");
    assert.ok(!(await page.locator("#main").isVisible()), "no church yet");
    await openChurch(page, "Szent Anna");
    assert.ok(!(await page.locator("#listcol").isVisible()), "the church replaces the list");
    const m = await page.locator("#main").boundingBox();
    assert.ok(r.y + r.height <= m.y + 1 && Math.abs(m.x) < 1 && m.width > 380, "church below the rail, full width");
    const box = await page.locator(".ad-side").boundingBox(), board = await page.locator("#board").boundingBox();
    assert.ok(box.y >= board.y + board.height - 1, "side boxes under the board");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll");
    await page.getByRole("button", { name: "‹ Lista" }).click();
    assert.ok(await page.locator("#listcol").isVisible());
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("a parish account opening admin.html is sent to plebania.html", async () => {
  const parish = fixture("staff-parish.json");
  const { page, close } = await openAdmin({ staff: parish.staff, user: parish.user });
  try {
    const link = page.getByRole("link", { name: "Tovább a plébániai felületre" });
    await link.waitFor({ timeout: 15000 });
    assert.equal(await link.getAttribute("href"), "plebania.html");
    assert.ok(!(await page.locator("#rail").isVisible()));
  } finally { await close(); }
});

// Statisztika: the report from analytics_report, drawn as tiles, a chart with a table view, and lists.
const REPORT = { from: "2026-11-03", to: "2026-11-09",
  days: ["03", "04", "05", "06", "07", "08", "09"].map((d, i) => ({ day: "2026-11-" + d, visits: 100 + i * 20, visitors: 80 + i * 10, new: 20 + i, views: 150 + i * 30 })),
  totals: { "visit:": 1120, "install:": 12, "locate:": 40, "device:phone": 700, "device:desktop": 300, "mode:app": 100, "mode:browser": 900, "tab:list": 400, "tab:saved": 50, "filter:conf": 220, "filter:mass": 90, "error:data": 3 },
  actions: { view: 1680, dir: 310, call: 22, web: 60, save: 75, share: 9, suggest: 4, search: 500, search_none: 37 },
  churches: [{ id: 1043, name: "Szent Anna-templom", city: "Eger", has_times: true, view: 240, dir: 60, call: 3, web: 9, save: 12, share: 1, suggest: 1 },
    { id: 1050, name: "Budapest-Belvárosi Nagyboldogasszony Főplébánia-templom (Belvárosi templom)", city: "Budapest V.", has_times: false, view: 90, dir: 0, call: 0, web: 0, save: 0, share: 0, suggest: 0 }],
  no_times: [{ id: 1050, name: "Budapest-Belvárosi Nagyboldogasszony Főplébánia-templom (Belvárosi templom)", city: "Budapest V.", view: 90 }],
  searches: [{ q: "eger", n: 44 }, { q: "bazilika", n: 31 }], searches_none: [{ q: "<b>szentkút</b>", n: 6 }],
  parish_saves: [{ id: 1043, name: "Szent Anna-templom", city: "Eger", who: "Szent Anna plébánia", at: "2026-11-08T21:14:00+01:00" }], parish_saves_count: 3,
  parish_never: [], parish_stale: [{ id: 1043, name: "Szent Anna-templom", city: "Eger", at: null }],
  suggestions: { received: 4, pending: 2 }, coverage: { churches: 4799, with_times: 3155, parish_managed: 2 } };

test("Statisztika shows the report: tiles, chart with tooltip and table, lists that open a church", async () => {
  let asked = null;
  const t = await openAdmin({ rpc: { analytics_report: b => { asked = b; return REPORT; } } });
  try {
    await t.page.locator('#rail [data-page="stats"]').click();
    await t.page.locator(".st-tiles").waitFor();
    assert.deepEqual(asked, { p_days: 30 });
    const text = await t.page.locator("#st-body").innerText();
    // Hungarian formatting groups digits only from five digits up (1120, but 10 000)
    for (const s of ["1120", "1680", "eger", "bazilika", "<b>szentkút</b>", "Telefon", "70%", "Gyóntatás", "Szent Anna plébánia", "nincs időpont"]) assert.ok(text.includes(s), `"${s}" in the page`);
    assert.equal(await t.page.locator("#st-body b").count() > 0, true);
    assert.equal(await t.page.locator("#st-chart .bar").count(), 7);
    // hover shows the day's value
    // the pointer is on the bar itself (near the baseline), not on the empty space above it
    { const bb = await t.page.locator("#st-chart .hit").nth(6).boundingBox(); await t.page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height - 6); }
    assert.match(await t.page.locator("#st-chart .st-tip").innerText(), /nov\. 9\.: 220/);
    // another measure redraws the same chart
    await t.page.locator('#st-m [data-m="views"]').click();
    assert.equal(await t.page.locator("#st-ctitle").innerText(), "Megnyitott templomoldal naponta");
    // table view
    await t.page.locator(".st-box details summary").click();
    assert.equal(await t.page.locator(".st-table tbody tr").count(), 7);
    // 7 days asks the database again
    await t.page.locator('#st-days [data-days="7"]').click(); await t.page.locator(".st-tiles").waitFor();
    assert.deepEqual(asked, { p_days: 7 });
    // the long name does not widen the page
    assert.equal(await t.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    // a row opens the church
    await t.page.locator(".st-box button.st-row", { hasText: "Szent Anna-templom" }).first().click();
    await t.page.locator(".ad-name", { hasText: "Szent Anna-templom" }).waitFor();
    assert.equal(await t.page.evaluate(() => localStorage.getItem("harangszo.notrack")), "1");
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test("Statisztika before the migration: says which file to run", async () => {
  const t = await openAdmin();
  try {
    await t.page.locator('#rail [data-page="stats"]').click();
    await t.page.locator("#st-body .ad-msg.err").waitFor();
    assert.match(await t.page.locator("#st-body").innerText(), /011_analytics\.sql/);
  } finally { await t.close(); }
});

