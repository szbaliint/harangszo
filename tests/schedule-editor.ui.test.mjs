// Task 5: the shared week board and time editor on tests/fixtures/schedule-editor.html, at phone size (360×740).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "./helpers/playwright.mjs";
import { startServer } from "./helpers/server.mjs";

let server, browser;
before(async () => { server = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.stop(); });

async function open(query = "", viewport = { width: 360, height: 740 }) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(`${server.url}/tests/fixtures/schedule-editor.html${query}`);
  await page.waitForSelector("body[data-ready]");
  page.errors = errors;
  return page;
}
const sheet = page => page.locator("dialog.se-sheet");
const ruleWith = (rules, pred) => (rules || []).find(pred);

test("board: a card per day, Sunday first, tiles and a ＋ per day", async () => {
  const page = await open();
  try {
    const days = await page.locator(".se-day .se-dh span").allTextContents();
    assert.deepEqual(days, ["Vasárnap", "Hétfő", "Kedd", "Szerda", "Csütörtök", "Péntek", "Szombat"]);
    assert.equal(await page.locator(".se-day.sun").count(), 1);
    assert.equal(await page.locator(".se-tile.se-add").count(), 7);
    assert.deepEqual(await page.locator(".se-day.sun .se-tile:not(.se-add) b").allTextContents(), ["08:00", "10:00", "18:00"]);
    assert.equal((await page.locator(".se-day.sun .se-dh small").textContent()).trim(), "3 alkalom");
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test("adding a 07:00 Mass on Kedd via ＋", async () => {
  const page = await open();
  try {
    await page.getByRole("button", { name: "Időpont hozzáadása: Kedd" }).click();
    await assert.doesNotReject(sheet(page).waitFor({ state: "visible" }));
    assert.equal(await sheet(page).locator("h2").textContent(), "Új időpont");
    assert.equal(await sheet(page).locator('[data-kind="mass"]').getAttribute("aria-pressed"), "true");
    assert.equal(await sheet(page).locator('[data-day="2"]').getAttribute("aria-pressed"), "true");
    await sheet(page).locator(".se-start").fill("07:00");
    await sheet(page).getByRole("button", { name: "Hozzáadás" }).click();
    await sheet(page).waitFor({ state: "hidden" });
    const last = await page.evaluate(() => window.last);
    assert.ok(ruleWith(last, r => r.kind === "mass" && r.days.includes(2) && r.start === "07:00"), JSON.stringify(last));
  } finally { await page.close(); }
});

test("adding a new time makes a new rule and a new tile", async () => {
  const page = await open();
  try {
    await page.getByRole("button", { name: "Időpont hozzáadása: Kedd" }).click();
    await sheet(page).locator(".se-start").fill("645");
    await sheet(page).locator('[data-day="4"]').click(); // also Thursday
    await sheet(page).getByRole("button", { name: "Hozzáadás" }).click();
    const last = await page.evaluate(() => window.last);
    const r = ruleWith(last, r => r.start === "06:45");
    assert.ok(r, "typed 645 becomes 06:45");
    assert.deepEqual(r.days, [2, 4]);
    assert.equal(r.end, "");
    for (const day of ["Kedd", "Csütörtök"]) {
      const card = page.locator(".se-day", { has: page.getByText(day, { exact: true }) });
      assert.equal(await card.locator(".se-tile b", { hasText: "06:45" }).count(), 1, `06:45 tile on ${day}`);
    }
  } finally { await page.close(); }
});

test("editing the Monday–Friday tile and unticking P", async () => {
  const page = await open();
  try {
    await page.locator(".se-day", { has: page.getByText("Hétfő", { exact: true }) }).locator(".se-tile", { hasText: "07:00" }).click();
    assert.equal(await sheet(page).locator("h2").textContent(), "Időpont módosítása");
    for (const d of [1, 2, 3, 4, 5]) assert.equal(await sheet(page).locator(`[data-day="${d}"]`).getAttribute("aria-pressed"), "true");
    assert.match(await sheet(page).locator(".se-sum").textContent(), /^Hétköznap \(hétfőtől péntekig\) 07:00-kor mise/);
    await sheet(page).getByRole("button", { name: "Péntek" }).click();
    assert.match(await sheet(page).locator(".se-sum").textContent(), /^Hétfőtől csütörtökig 07:00-kor mise/);
    await sheet(page).getByRole("button", { name: "Mentés" }).click();
    const last = await page.evaluate(() => window.last);
    assert.deepEqual(ruleWith(last, r => r.start === "07:00" && r.kind === "mass").days, [1, 2, 3, 4]);
    assert.equal(last.length, 7, "still seven rules, in the same place");
    assert.equal(last[0].start, "07:00");
  } finally { await page.close(); }
});

test("Törlés asks to confirm, then removes the rule", async () => {
  const page = await open();
  try {
    await page.locator(".se-day", { has: page.getByText("Péntek", { exact: true }) }).locator(".se-tile", { hasText: "17:00" }).click();
    const del = sheet(page).locator('[data-act="del"]');
    assert.equal(await del.textContent(), "Törlés");
    await del.click();
    assert.equal(await del.textContent(), "Biztosan törlöd?");
    assert.equal(await page.evaluate(() => window.changes), 0, "nothing removed yet");
    assert.ok(await sheet(page).evaluate(d => d.open));
    await del.click();
    await sheet(page).waitFor({ state: "hidden" });
    const last = await page.evaluate(() => window.last);
    assert.equal(last.length, 6);
    assert.equal(ruleWith(last, r => r.kind === "confession"), undefined);
    assert.equal(await page.locator(".se-tile.k-confession").count(), 0);
  } finally { await page.close(); }
});

test("an add sheet has no Törlés; Mégse closes without a change", async () => {
  const page = await open();
  try {
    await page.getByRole("button", { name: "Időpont hozzáadása: Szerda" }).click();
    assert.equal(await sheet(page).locator('[data-act="del"]').count(), 0);
    await sheet(page).getByRole("button", { name: "Mégse" }).click();
    await sheet(page).waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.changes), 0);
  } finally { await page.close(); }
});

test("Haladó only with admin: true; Rorate only for admin", async () => {
  for (const [q, admin] of [["", false], ["?admin=1", true]]) {
    const page = await open(q);
    try {
      await page.getByRole("button", { name: "Időpont hozzáadása: Hétfő" }).click();
      const text = await sheet(page).textContent();
      assert.equal(text.includes("Haladó"), admin, `Haladó with admin=${admin}`);
      assert.equal(await sheet(page).locator('[data-kind="rorate"]').count(), admin ? 1 : 0, `Rorate with admin=${admin}`);
    } finally { await page.close(); }
  }
});

test("validation messages: start, end after start, at least one day", async () => {
  const page = await open();
  try {
    await page.getByRole("button", { name: "Időpont hozzáadása: Hétfő" }).click();
    const msg = sheet(page).locator(".se-msg"), save = sheet(page).getByRole("button", { name: "Hozzáadás" });
    await save.click();
    assert.match(await msg.textContent(), /hánykor kezdődik/);
    assert.ok(await sheet(page).evaluate(d => d.open), "sheet stays open");
    assert.equal(await sheet(page).locator(".se-start").evaluate(e => e.classList.contains("err") && e === document.activeElement), true);
    await sheet(page).getByRole("button", { name: "Gyóntatás" }).click();
    await sheet(page).locator(".se-start").fill("17:30");
    await sheet(page).locator(".se-endf input").fill("17:00");
    await save.click();
    assert.match(await msg.textContent(), /vége legyen később/);
    await sheet(page).locator(".se-endf input").fill("18:00");
    await sheet(page).getByRole("button", { name: "Hétfő" }).click(); // untick the only day
    await save.click();
    assert.match(await msg.textContent(), /legalább egy napot/);
    await sheet(page).getByRole("button", { name: "Vasárnap" }).click();
    await save.click();
    await sheet(page).waitFor({ state: "hidden" });
    const r = ruleWith(await page.evaluate(() => window.last), r => r.kind === "confession" && r.start === "17:30");
    assert.deepEqual([r.days, r.end, r.tags], [[0], "18:00", []]);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test("Mise and Rorate have no end field; tags only for Mass", async () => {
  const page = await open("?admin=1");
  try {
    await page.getByRole("button", { name: "Időpont hozzáadása: Hétfő" }).click();
    await sheet(page).locator(".se-more summary").click();
    assert.equal(await sheet(page).locator(".se-endf").isVisible(), false);
    assert.equal(await sheet(page).getByRole("button", { name: "orgonás" }).isVisible(), true);
    await sheet(page).getByRole("button", { name: "Szentségimádás" }).click();
    assert.equal(await sheet(page).locator(".se-endf").isVisible(), true);
    assert.equal(await sheet(page).getByRole("button", { name: "orgonás" }).isVisible(), false);
    await sheet(page).getByRole("button", { name: "Rorate" }).click();
    assert.equal(await sheet(page).locator(".se-endf").isVisible(), false);
    assert.equal(await sheet(page).locator('select[data-f="period"]').isVisible(), false, "Rorate is always Advent");
  } finally { await page.close(); }
});

test("Kéthetente: the coming week's Monday as anchor, saved as every 2", async () => {
  const page = await open();
  try {
    await page.getByRole("button", { name: "Időpont hozzáadása: Vasárnap" }).click();
    await sheet(page).locator(".se-start").fill("17:30");
    await sheet(page).getByRole("button", { name: "Kéthetente" }).click();
    const anchor = await sheet(page).locator('input[data-f="anchorWeek"]').inputValue();
    assert.match(anchor, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(new Date(anchor + "T12:00").getDay(), 1, "a Monday");
    assert.match(await sheet(page).locator(".se-sum").textContent(), /kéthetente/);
    await sheet(page).getByRole("button", { name: "Hozzáadás" }).click();
    const r = ruleWith(await page.evaluate(() => window.last), r => r.start === "17:30");
    assert.deepEqual([r.days, r.every, r.anchor, r.weeks], [[0], 2, anchor, []]);
  } finally { await page.close(); }
});

test("A hónap … hetében: weeks[] from the week chips, required", async () => {
  const page = await open();
  try {
    await page.getByRole("button", { name: "Időpont hozzáadása: Péntek" }).click();
    await sheet(page).locator(".se-start").fill("18:00");
    await sheet(page).getByRole("button", { name: "A hónap … hetében" }).click();
    await sheet(page).getByRole("button", { name: "Hozzáadás" }).click();
    assert.match(await sheet(page).locator(".se-msg").textContent(), /melyik hetében/);
    await sheet(page).getByRole("button", { name: "1.", exact: true }).click();
    await sheet(page).getByRole("button", { name: "utolsó" }).click();
    assert.match(await sheet(page).locator(".se-sum").textContent(), /a hónap első és utolsó hetében/);
    await sheet(page).getByRole("button", { name: "Hozzáadás" }).click();
    const r = ruleWith(await page.evaluate(() => window.last), r => r.days.join() === "5" && r.start === "18:00");
    assert.deepEqual([r.weeks, r.every], [[1, -1], 1]);
  } finally { await page.close(); }
});

test("details fold: period with own dates, language, celebrant, place church, feast_skip", async () => {
  const page = await open();
  try {
    await page.getByRole("button", { name: "Időpont hozzáadása: Szombat" }).click();
    await sheet(page).locator(".se-start").fill("19:00");
    await sheet(page).locator(".se-more summary").click();
    await sheet(page).locator('select[data-f="period"]').selectOption("custom");
    await sheet(page).locator('input[data-buf="rFrom"]').fill("6.15");
    await sheet(page).locator('input[data-buf="rTo"]').fill("08-31");
    await sheet(page).locator('select[data-f="lang"]').selectOption("la");
    await sheet(page).getByRole("button", { name: "előesti" }).click();
    await sheet(page).locator('input[data-f="celebrant"]').fill("P. Kamill");
    await sheet(page).locator('select[data-f="place_church_id"]').selectOption("1044");
    await sheet(page).locator('.se-more input[data-f="feast_skip"]').check();
    assert.equal(await sheet(page).locator(".se-sum").textContent(),
      "Szombaton 19:00-kor mise (latin nyelvű, előesti), minden héten, jún. 15.–aug. 31. között, ünnepnapokon elmarad, helyszín: Ciszterci templom, bemutatja: P. Kamill.");
    await sheet(page).getByRole("button", { name: "Hozzáadás" }).click();
    const r = ruleWith(await page.evaluate(() => window.last), r => r.start === "19:00");
    assert.deepEqual({ period: r.period, valid: r.valid, tags: r.tags, celebrant: r.celebrant, place_church_id: r.place_church_id, feast_skip: r.feast_skip },
      { period: "all", valid: "06-15/08-31", tags: ["lang:la", "vigil"], celebrant: "P. Kamill", place_church_id: 1044, feast_skip: true });
  } finally { await page.close(); }
});

test("admin Haladó and the plain questions stay in sync", async () => {
  const page = await open("?admin=1");
  try {
    await page.locator(".se-day", { has: page.getByText("Csütörtök", { exact: true }) }).locator(".se-tile", { hasText: "18:30" }).click();
    // A long sheet scrolls; its folds keep their full height (not squashed to their borders).
    for (const s of [".se-more", ".se-adv"]) assert.ok((await sheet(page).locator(s).boundingBox()).height >= 44, `${s} keeps its height`);
    await sheet(page).locator(".se-adv summary").click();
    assert.equal(await sheet(page).locator('input[data-buf="weeks"]').inputValue(), "1");
    assert.equal(await sheet(page).locator('[data-freq="weeks"]').getAttribute("aria-pressed"), "true");
    // Raw weeks → the week chips
    await sheet(page).locator('input[data-buf="weeks"]').fill("1,3");
    await sheet(page).locator('input[data-buf="weeks"]').press("Tab");
    assert.equal(await sheet(page).locator('[data-wk="3"]').getAttribute("aria-pressed"), "true");
    // Plain pill → raw fields
    await sheet(page).getByRole("button", { name: "Kéthetente" }).click();
    assert.equal(await sheet(page).locator('input[data-buf="every"]').inputValue(), "2");
    assert.equal(await sheet(page).locator('input[data-buf="weeks"]').inputValue(), "");
    const anchor = await sheet(page).locator('input[data-f="anchor"]').inputValue();
    assert.equal(anchor, await sheet(page).locator('input[data-f="anchorWeek"]').inputValue());
    // Raw every 3 → the plain select; raw valid → the plain range
    await sheet(page).locator('input[data-buf="every"]').fill("3");
    await sheet(page).locator('input[data-buf="every"]').press("Tab");
    assert.equal(await sheet(page).locator('select[data-f="every"]').inputValue(), "3");
    await sheet(page).locator('input[data-buf="valid"]').fill("09-01/06-15");
    await sheet(page).locator('input[data-buf="valid"]').press("Tab");
    assert.equal(await sheet(page).locator('select[data-f="period"]').inputValue(), "custom");
    assert.equal(await sheet(page).locator('input[data-buf="rFrom"]').inputValue(), "09-01");
    // Both feast_skip boxes are one field
    await sheet(page).locator('.se-adv input[data-f="feast_skip"]').check();
    assert.equal(await sheet(page).locator('.se-more input[data-f="feast_skip"]').isChecked(), true);
    // A bad raw value blocks saving with a message
    await sheet(page).locator('input[data-buf="weeks"]').fill("7");
    await sheet(page).locator('input[data-buf="weeks"]').press("Tab");
    await sheet(page).getByRole("button", { name: "Mentés" }).click();
    assert.match(await sheet(page).locator(".se-msg").textContent(), /heteket így írd/);
    await sheet(page).locator('input[data-buf="weeks"]').fill("");
    await sheet(page).locator('input[data-buf="weeks"]').press("Tab");
    await sheet(page).getByRole("button", { name: "Mentés" }).click();
    await sheet(page).waitFor({ state: "hidden" });
    const r = ruleWith(await page.evaluate(() => window.last), r => r.kind === "adoration");
    assert.deepEqual({ every: r.every, anchor: r.anchor, weeks: r.weeks, valid: r.valid, feast_skip: r.feast_skip, end: r.end, tags: r.tags },
      { every: 3, anchor, weeks: [], valid: "09-01/06-15", feast_skip: true, end: "19:30", tags: [] });
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test("crowded day: 8 Sunday times wrap inside the card, ＋ stays reachable", async () => {
  const page = await open("?crowded=1");
  try {
    const r = await page.evaluate(() => {
      const card = document.querySelector(".se-day.sun").getBoundingClientRect();
      const tiles = [...document.querySelectorAll(".se-day.sun .se-tile")].map(t => t.getBoundingClientRect());
      return {
        card: card.toJSON(), n: tiles.length,
        outside: tiles.filter(t => t.left < card.left - 0.5 || t.right > card.right + 0.5 || t.top < card.top - 0.5 || t.bottom > card.bottom + 0.5).length,
        rows: new Set(tiles.map(t => Math.round(t.top))).size,
        hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    assert.equal(r.n, 9, "8 tiles and the ＋");
    assert.equal(r.outside, 0, "every tile inside the day card");
    assert.ok(r.rows >= 3, `tiles wrap (${r.rows} rows)`);
    assert.equal(r.hscroll, false, "no horizontal scroll");
    const add = page.getByRole("button", { name: "Időpont hozzáadása: Vasárnap" });
    await add.click(); // Playwright checks it is visible, stable and not covered
    await sheet(page).waitFor({ state: "visible" });
  } finally { await page.close(); }
});

test("laptop width: day name column, tiles on one line", async () => {
  const page = await open("?admin=1", { width: 1100, height: 800 });
  try {
    const r = await page.evaluate(() => {
      const day = document.querySelector(".se-day.sun"), h = day.querySelector(".se-dh").getBoundingClientRect(), t = day.querySelector(".se-tile:not(.se-add)");
      const b = t.querySelector("b").getBoundingClientRect(), s = t.querySelector("span").getBoundingClientRect();
      return { cols: getComputedStyle(day).gridTemplateColumns, nameW: h.width, sameLine: Math.abs(b.bottom - s.bottom) < 4 && s.left > b.right };
    });
    assert.match(r.cols, /^96px /);
    assert.ok(r.sameLine, "time and text on one line");
  } finally { await page.close(); }
});
