// A church's own feasts (churches.own_feasts, migration 015) in calendar.js: the day they fall on, the next one, the
// leap day, keys and dates (no browser).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { ROOT } from "./helpers/server.mjs";

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(ROOT, "calendar.js"), "utf8"), ctx, { filename: "calendar.js" });
const C = ctx.LitCal;
const D = (y, m, d) => new Date(y, m - 1, d);
const ymd = d => d && C.ymd(d);
// Values made inside the context have its own prototypes; compare them as plain JSON data.
const plain = x => JSON.parse(JSON.stringify(x));
const OWN = [{ key: "own_1", name: "Szent Anna búcsú", md: "07-26" }, { key: "own_2", name: "Szökőnapi ünnep", md: "02-29" }];

test("ownFeastsOn: the feasts whose month and day match the date, every year", () => {
  assert.deepEqual(plain(C.ownFeastsOn(OWN, D(2027, 7, 26))).map(f => f.key), ["own_1"]);
  assert.deepEqual(plain(C.ownFeastsOn(OWN, D(2031, 7, 26))).map(f => f.name), ["Szent Anna búcsú"]);
  assert.deepEqual(plain(C.ownFeastsOn(OWN, D(2027, 7, 25))), []);
  assert.deepEqual(plain(C.ownFeastsOn(OWN, D(2027, 6, 26))), []);
  // No list, or not a list: nothing.
  assert.deepEqual(plain(C.ownFeastsOn(undefined, D(2027, 7, 26))), []);
  assert.deepEqual(plain(C.ownFeastsOn(null, D(2027, 7, 26))), []);
  assert.deepEqual(plain(C.ownFeastsOn({}, D(2027, 7, 26))), []);
});

test("leap day: 02-29 is held in leap years only; in other years it is not shown at all", () => {
  assert.deepEqual(plain(C.ownFeastsOn(OWN, D(2028, 2, 29))).map(f => f.key), ["own_2"]);
  // 2027 has no 29 February: neither 28 February nor 1 March takes it over.
  assert.deepEqual(plain(C.ownFeastsOn(OWN, D(2027, 2, 28))), []);
  assert.deepEqual(plain(C.ownFeastsOn(OWN, D(2027, 3, 1))), []);
  assert.equal(ymd(C.nextOwnFeastDate("02-29", D(2026, 11, 16))), "2028-02-29");
  assert.equal(ymd(C.nextOwnFeastDate("02-29", D(2028, 3, 1))), "2032-02-29");
  // 2100 is not a leap year: the next one after 2096 is 2104.
  assert.equal(ymd(C.nextOwnFeastDate("02-29", D(2096, 3, 1))), "2104-02-29");
});

test("nextOwnFeastDate: on or after the given day, this year or the next", () => {
  assert.equal(ymd(C.nextOwnFeastDate("07-26", D(2026, 11, 16))), "2027-07-26");
  assert.equal(ymd(C.nextOwnFeastDate("07-26", D(2027, 7, 26))), "2027-07-26", "the day itself counts");
  assert.equal(ymd(C.nextOwnFeastDate("07-26", D(2027, 7, 27))), "2028-07-26");
  assert.equal(ymd(C.nextOwnFeastDate("12-31", new Date(2026, 11, 31, 23, 59))), "2026-12-31", "the time of day does not matter");
  assert.equal(ymd(C.nextOwnFeastDate("01-01", D(2026, 12, 31))), "2027-01-01");
  for (const bad of ["", null, "7-26", "13-01", "00-10", "04-31", "02-30", "07-00", "07-32", "0726"]) assert.equal(C.nextOwnFeastDate(bad, D(2026, 1, 1)), null, String(bad));
});

test("mdOk: real calendar days only, 02-29 allowed", () => {
  for (const md of ["01-01", "02-29", "04-30", "07-26", "12-31"]) assert.equal(C.mdOk(md), true, md);
  for (const md of ["", undefined, "1-01", "01-1", "13-01", "00-01", "01-00", "02-30", "04-31", "06-31", "09-31", "11-31", "01-32", "01/01", " 01-01"]) assert.equal(C.mdOk(md), false, String(md));
});

test("keys: own_<n>; the first free one is used for a new feast", () => {
  for (const k of ["own_1", "own_10", "own_999"]) assert.equal(C.isOwnKey(k), true, k);
  for (const k of ["own_", "own_1000", "own_a", "aug15", "holyday", "", undefined, "xown_1"]) assert.equal(C.isOwnKey(k), false, String(k));
  assert.equal(C.newOwnKey([]), "own_1");
  assert.equal(C.newOwnKey(undefined), "own_1");
  assert.equal(C.newOwnKey(OWN), "own_3");
  assert.equal(C.newOwnKey([{ key: "own_2" }]), "own_1");
  assert.equal(C.OWN_FEASTS_MAX, 10);
  assert.equal(C.MONTHS.length, 12);
  assert.equal(C.MONTHS[6], "július");
});

test("own feasts never count as built-in feasts, groups or holidays", () => {
  assert.equal(C.FEAST_BY_KEY.own_1, undefined);
  assert.equal(C.isGroup("own_1"), false);
  assert.equal(C.nextFeastDate("own_1", D(2026, 1, 1)), null);
  assert.ok(!C.feastsOn(D(2027, 7, 26)).some(C.isOwnKey));
});
