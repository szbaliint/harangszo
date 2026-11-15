// Task 5: schedule-editor.js rule ⇄ day-item conversion and the Hungarian summary (no browser).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./helpers/server.mjs";

// Load calendar.js and schedule-editor.js as plain browser scripts into one context (no `module` there).
const ctx = vm.createContext({});
for (const f of ["calendar.js", "schedule-editor.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
const SE = ctx.ScheduleEditor;
// Values made inside the context have its own prototypes; compare them as plain JSON data.
const plain = x => JSON.parse(JSON.stringify(x));

const church = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/church-1043.json"), "utf8"));
const hm = t => t ? String(t).slice(0, 5) : "";
// The Rule shape, read from the database exactly as admin.js openChurch maps services.
const toRule = s => ({ kind: s.kind, days: s.days, start: hm(s.start_time), end: hm(s.end_time), note: s.note || "", period: s.period || "all", valid: s.valid || "",
  weeks: s.weeks || [], every: s.every || 1, anchor: s.anchor || "", tags: s.tags || [], celebrant: s.celebrant || "", place: s.place || "",
  place_church_id: s.place_church_id || "", feast_skip: !!s.feast_skip });
const rules = church.services.filter(s => !s.feast).map(toRule);
const rule = o => ({ kind: "mass", days: [0], start: "10:00", end: "", note: "", period: "all", valid: "", weeks: [], every: 1, anchor: "", tags: [], celebrant: "",
  place: "", place_church_id: "", feast_skip: false, ...o });

test("exposes window.ScheduleEditor in a browser-like context", () => {
  for (const k of ["split", "join", "describe", "mount"]) assert.equal(typeof SE[k], "function", k);
});

test("module.exports under Node (calendar.js required next to it)", () => {
  const require = createRequire(import.meta.url);
  const M = require(path.join(ROOT, "schedule-editor.js"));
  assert.equal(typeof M.describe, "function");
  assert.equal(M.describe(rule({ days: [0], start: "08:00" })), "Vasárnap 08:00-kor mise, minden héten, egész évben.");
});

test("split gives one item per (rule, day), each with a uid", () => {
  const items = plain(SE.split(rules));
  assert.equal(items.length, rules.reduce((n, r) => n + r.days.length, 0));
  assert.equal(new Set(items.map(i => i.uid)).size, items.length, "uids are unique");
  assert.deepEqual(items.filter(i => i.start === "07:00").map(i => i.day), [1, 2, 3, 4, 5]);
});

test("join(split(rules)) gives the fixture's rules back", () => {
  assert.ok(rules.length >= 6);
  assert.deepEqual(plain(SE.join(SE.split(rules))), plain(rules));
});

test("join keeps rules apart when only the start differs", () => {
  const two = [rule({ days: [1, 2], start: "07:00" }), rule({ days: [1, 2], start: "08:00" })];
  assert.deepEqual(plain(SE.join(SE.split(two))), plain(two));
});

test("join merges equal items and sorts the days", () => {
  const items = plain(SE.split([rule({ days: [5], start: "18:00" }), rule({ days: [1, 3], start: "18:00" })]));
  assert.deepEqual(plain(SE.join(items)), [rule({ days: [1, 3, 5], start: "18:00" })]);
});

test("join keeps a rule without days", () => {
  const r = [rule({ days: [] })];
  assert.deepEqual(plain(SE.join(SE.split(r))), plain(r));
});

test("describe: weekday Mass, the exact sentence", () => {
  assert.equal(SE.describe({ kind: "mass", days: [1, 2, 3, 4, 5], start: "18:00", end: "", note: "", period: "all", valid: "", every: 1, weeks: [], anchor: "", tags: [] }),
    "Hétköznap (hétfőtől péntekig) 18:00-kor mise, minden héten, egész évben.");
});

test("describe: fortnightly Sunday confession with an end", () => {
  const s = SE.describe(rule({ kind: "confession", days: [0], start: "17:30", end: "18:00", every: 2, anchor: "2026-11-09" }));
  assert.match(s, /kéthetente/);
  assert.match(s, /17:30–18:00/);
  assert.equal(s, "Vasárnap 17:30–18:00 gyóntatás, kéthetente, egész évben.");
});

test("describe: days, weeks of the month, seasons and details", () => {
  assert.equal(SE.describe(rule({ days: [0, 1, 2, 3, 4, 5, 6], start: "07:00" })), "Minden nap 07:00-kor mise, minden héten, egész évben.");
  assert.equal(SE.describe(rule({ kind: "adoration", days: [2, 4], start: "18:00", weeks: [1, 3] })), "Kedden és csütörtökön 18:00-kor szentségimádás, a hónap első és harmadik hetében, egész évben.");
  assert.equal(SE.describe(rule({ days: [1, 2, 3, 4, 5, 6], start: "18:00", period: "school" })), "Hétfőtől szombatig 18:00-kor mise, minden héten, tanévben.");
  assert.equal(SE.describe(rule({ days: [1, 3, 5], start: "06:30", valid: "06-15/08-31" })), "Hétfőn, szerdán és pénteken 06:30-kor mise, minden héten, jún. 15.–aug. 31. között.");
  assert.equal(SE.describe(rule({ days: [5], start: "17:00", weeks: [-1], feast_skip: true, tags: ["lang:la", "solemn"], celebrant: "P. Kamill", place: "temetőkápolna" })),
    "Pénteken 17:00-kor mise (latin nyelvű, ünnepi), a hónap utolsó hetében, egész évben, ünnepnapokon elmarad, helyszín: temetőkápolna, bemutatja: P. Kamill.");
  assert.equal(SE.describe(rule({ kind: "prayer", days: [6, 0], start: "17:30", note: "Rózsafüzér" })), "Hétvégén (szombaton és vasárnap) 17:30-kor Rózsafüzér, minden héten, egész évben.");
  assert.equal(SE.describe(rule({ kind: "rorate", days: [1, 2, 3, 4, 5, 6], start: "06:00" })), "Hétfőtől szombatig 06:00-kor rorate (adventi hajnali mise), minden héten.");
});
