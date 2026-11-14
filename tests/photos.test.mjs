// Church photos in the parish portal and the admin (church-photo.js): pick → downscale to a 1600 px JPEG → upload to
// the church-photos bucket as <church id>/<timestamp>.jpg → set_church_photo; remove; Commons photos; failures.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium, devices } from "./helpers/playwright.mjs";
import { startServer } from "./helpers/server.mjs";
import { mockSupabase, SUPABASE_URL } from "./helpers/supabase-mock.mjs";

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const { defaultBrowserType: _, ...IPHONE } = devices["iPhone 13"];
const LAPTOP = { viewport: { width: 1440, height: 900 } };
const PUBLIC = `${SUPABASE_URL}/storage/v1/object/public/church-photos/`;
const COMMONS = { photo_url: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Eger_Szent_Anna.jpg/1000px-Eger_Szent_Anna.jpg",
  photo_credit: "Fotó: Kovács János · CC BY-SA 4.0 · Wikimedia Commons", photo_source: "commons", photo_page: "https://commons.wikimedia.org/wiki/File:Eger_Szent_Anna.jpg" };

let server, browser;
before(async () => { server = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.stop(); });

// Width and height from a JPEG's SOF marker.
function jpegSize(b) {
  assert.deepEqual([b[0], b[1]], [0xff, 0xd8], "a JPEG");
  for (let i = 2; i + 9 < b.length;) {
    assert.equal(b[i], 0xff, "JPEG marker");
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  throw new Error("no SOF marker");
}
// A w×h PNG drawn by the browser (a photo straight from a phone is bigger than the 1600 px we keep).
const makePng = (page, w, h) => page.evaluate(([w, h]) => {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"); g.fillStyle = "#8fb3d9"; g.fillRect(0, 0, w, h); g.fillStyle = "#e9e1cf"; g.fillRect(w * .35, h * .35, w * .3, h * .5);
  return c.toDataURL("image/png").split(",")[1];
}, [w, h]).then(b64 => Buffer.from(b64, "base64"));

async function portal({ church = fixture("church-1043.json"), setPhoto } = {}) {
  const context = await browser.newContext({ ...IPHONE, timezoneId: "Europe/Budapest" });
  const page = await context.newPage();
  const errors = [], dialogs = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("dialog", d => { dialogs.push(d.message()); d.accept(); });
  const parish = fixture("staff-parish.json");
  const { calls } = await mockSupabase(page, {
    user: parish.user, staff: parish.staff, tables: { staff_churches: parish.staff_churches, churches: [church] },
    rpc: { save_church: () => 1043, set_church_photo: setPhoto || (b => {
      // what the database does (migration 013): the parish's own upload, with the parish credit; or nothing
      Object.assign(church, b.url ? { photo_url: b.url, photo_credit: "Fotó: a plébánia", photo_source: "parish", photo_page: null }
        : { photo_url: null, photo_credit: null, photo_source: null, photo_page: null });
      return null;
    }) },
  });
  await page.goto(`${server.url}/plebania.html`);
  await page.locator(".se-day").first().waitFor({ timeout: 15000 });
  await page.locator('.ui-tab[data-sec="data"]').click();
  await page.locator("#photo .cp-acts button").first().waitFor();
  return { page, calls, errors, dialogs, church, close: () => context.close() };
}
async function pick(page, buffer, name = "templom.png", mimeType = "image/png") {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Fotó feltöltése" }).click()]);
  await chooser.setFiles({ name, mimeType, buffer });
}
const uploads = calls => calls.filter(c => c.method === "POST" && c.path.startsWith("/storage/v1/object/church-photos/"));
const removals = calls => calls.filter(c => c.method === "DELETE" && c.path === "/storage/v1/object/church-photos");
const photoRpc = calls => calls.filter(c => c.path === "/rest/v1/rpc/set_church_photo");

test("portal: a picked photo is made 1600 px wide, uploaded to <id>/<timestamp>.jpg and put on the church", async () => {
  const { page, calls, errors, close } = await portal();
  try {
    assert.match(await page.locator("#photo .cp-none").textContent(), /Még nincs fotó/);
    assert.equal(await page.getByRole("button", { name: "Fotó törlése" }).count(), 0, "nothing to remove yet");
    await pick(page, await makePng(page, 3000, 2000));
    await page.locator("#photo .cp-fig img").waitFor();
    // one upload: a JPEG, at most 1600 px on the long edge, in this church's folder
    const [up] = uploads(calls);
    assert.match(up.path, /^\/storage\/v1\/object\/church-photos\/1043\/\d{13}\.jpg$/);
    assert.equal(up.body.type, "image/jpeg");
    assert.deepEqual(jpegSize(up.file), { w: 1600, h: 1067 });
    assert.ok(up.file.length < 5 * 1024 * 1024);
    // then set_church_photo with the bucket's public URL of that file
    const path = up.path.slice("/storage/v1/object/church-photos/".length);
    assert.deepEqual(photoRpc(calls).map(c => c.body), [{ cid: 1043, url: PUBLIC + path }]);
    assert.equal(await page.locator("#photo .cp-fig img").getAttribute("src"), PUBLIC + path);
    await page.waitForFunction(() => document.querySelector("#photo .cp-fig img").naturalWidth === 1600);
    assert.equal((await page.locator("#photo .cp-credit").textContent()).trim(), "Fotó: a plébánia");
    await page.locator("#toast.on").waitFor();
    assert.equal((await page.locator("#toast").textContent()).trim(), "A fotó felkerült · már látszik a térképen");
    assert.equal(await page.locator("#savebar.on").count(), 0, "saved at once, not with the save bar");
    assert.deepEqual(removals(calls), [], "nothing to clean up");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("portal: a new photo replaces the old file; Fotó törlése asks, removes it from the church and the bucket", async () => {
  const { page, calls, errors, dialogs, church, close } = await portal();
  try {
    await pick(page, await makePng(page, 800, 1200));
    await page.locator("#photo .cp-fig img").waitFor();
    const first = uploads(calls)[0].path.slice("/storage/v1/object/church-photos/".length);
    assert.deepEqual(jpegSize(uploads(calls)[0].file), { w: 800, h: 1200 }, "a small photo keeps its size");
    await page.waitForTimeout(5); // a new timestamp
    await pick(page, await makePng(page, 1200, 900));
    await page.waitForFunction(old => !document.querySelector("#photo .cp-fig img").src.endsWith(old), first);
    const second = uploads(calls)[1].path.slice("/storage/v1/object/church-photos/".length);
    assert.notEqual(second, first);
    for (let i = 0; i < 40 && !removals(calls).length; i++) await page.waitForTimeout(25);
    assert.deepEqual(removals(calls).map(c => c.body), [{ prefixes: [first] }], "the replaced file is deleted");
    // remove
    await page.getByRole("button", { name: "Fotó törlése" }).click();
    await page.locator("#photo .cp-none").waitFor();
    assert.match(dialogs.at(-1), /Biztosan törlöd a fotót\?/);
    assert.deepEqual(photoRpc(calls).at(-1).body, { cid: 1043, url: null });
    for (let i = 0; i < 40 && removals(calls).length < 2; i++) await page.waitForTimeout(25);
    assert.deepEqual(removals(calls).at(-1).body, { prefixes: [second] });
    assert.equal(church.photo_url, null);
    assert.equal((await page.locator("#toast").textContent()).trim(), "A fotót töröltük");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("portal: a Commons photo shows its credit as a link; the parish may replace it but not remove it", async () => {
  const { page, calls, errors, close } = await portal({ church: { ...fixture("church-1043.json"), ...COMMONS } });
  try {
    const credit = page.locator("#photo .cp-credit a");
    assert.equal(await credit.getAttribute("href"), COMMONS.photo_page);
    assert.equal((await credit.textContent()).trim(), COMMONS.photo_credit);
    assert.match(await page.locator("#photo .cp-note").textContent(), /Wikimedia Commons.*saját fotóval lecserélheted/);
    assert.equal(await page.getByRole("button", { name: "Fotó törlése" }).count(), 0);
    await pick(page, await makePng(page, 2000, 1500));
    await page.locator("#photo .cp-credit", { hasText: "Fotó: a plébánia" }).waitFor();
    assert.equal(photoRpc(calls).length, 1);
    assert.deepEqual(removals(calls), [], "a Commons file is not ours to delete");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("portal: when the database refuses the photo, the uploaded file is deleted and the reason is shown", async () => {
  const { page, calls, errors, close } = await portal({ setPhoto: () => { throw new Error("Nincs jogod ennek a templomnak a fotóját módosítani (id 1043)."); } });
  try {
    await pick(page, await makePng(page, 1000, 700));
    await page.locator("#photo .cp-msg.err").waitFor();
    assert.match(await page.locator("#photo .cp-msg").textContent(), /Nem sikerült a fotót a templomhoz tenni: Nincs jogod/);
    const path = uploads(calls)[0].path.slice("/storage/v1/object/church-photos/".length);
    for (let i = 0; i < 40 && !removals(calls).length; i++) await page.waitForTimeout(25);
    assert.deepEqual(removals(calls).map(c => c.body), [{ prefixes: [path] }]);
    assert.equal(await page.locator("#photo .cp-fig").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Fotó feltöltése" }).isEnabled(), true);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("portal: a file that is not an image is refused before anything is uploaded", async () => {
  const { page, calls, close } = await portal();
  try {
    await pick(page, Buffer.from("not a photo"), "miserend.pdf", "application/pdf");
    await page.locator("#photo .cp-msg.err").waitFor();
    assert.match(await page.locator("#photo .cp-msg").textContent(), /nem tudtuk fotóként megnyitni/);
    assert.deepEqual(uploads(calls), []);
  } finally { await close(); }
});

test("admin: Adatok shows the photo; the admin can remove a Commons photo", async () => {
  const context = await browser.newContext({ ...LAPTOP, timezoneId: "Europe/Budapest" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("dialog", d => d.accept());
  try {
    const admin = fixture("staff-admin.json"), church = { ...fixture("church-1043.json"), ...COMMONS };
    const { calls } = await mockSupabase(page, {
      user: admin.user, staff: admin.staff,
      tables: { churches: [church], admin_church_list: [{ id: 1043, name: church.name, city: church.city, published: true, n_services: 7, n_pending: 0, importance: 60 }] },
      rpc: { set_church_photo: b => { Object.assign(church, { photo_url: b.url, photo_credit: null, photo_source: null, photo_page: null }); return null; } },
    });
    await page.goto(`${server.url}/admin.html`);
    await page.locator("#clist .ad-it").first().click({ timeout: 15000 });
    await page.locator(".ad-tab", { hasText: "Adatok" }).click();
    await page.locator("#photo .cp-fig img").waitFor();
    assert.equal(await page.locator("#photo .cp-credit a").getAttribute("href"), COMMONS.photo_page);
    await page.getByRole("button", { name: "Fotó törlése" }).click();
    await page.locator("#photo .cp-none").waitFor();
    assert.deepEqual(calls.filter(c => c.path === "/rest/v1/rpc/set_church_photo").map(c => c.body), [{ cid: 1043, url: null }]);
    assert.equal(await page.locator("#savebar.on").count(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("church-photo.js and its use are deployed", () => {
  const cp = readFileSync(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8").split("\n").find(l => /^\s*cp index\.html/.test(l));
  assert.ok(cp.split(/\s+/).includes("church-photo.js"));
  for (const f of ["plebania.html", "admin.html"]) assert.match(readFileSync(new URL("../" + f, import.meta.url), "utf8"), /<script src="church-photo\.js"><\/script>/, f);
});
