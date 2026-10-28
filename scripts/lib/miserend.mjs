// miserend.hu data: reading its SQLite export and turning concrete Mass dates into Harangszó's weekly rules.
//
// miserend.hu publishes every church and Mass as an SQLite file (https://miserend.hu/apidocs):
//  - v5: one row per Mass and period, with an RFC 5545 rrule, the period's first and last day and excluded dates;
//  - v4: one row per single occurrence, for the next six months.
// Both are first expanded into concrete dates, then deriveSchedule() finds the weekly / nth-week-of-month rules,
// their seasons (summer/winter by the clock change, Advent, or a date range) and feast-day exceptions.
import fs from "fs";
import vm from "vm";
import { fileURLToPath } from "url";
import rrulePkg from "rrule";
import { parseNote, langTag } from "./notes.mjs";
const { RRule } = rrulePkg;

export const SOURCE = "miserend";
export const SOURCE_NAME = "miserend.hu";
export const churchUrl = tid => `https://miserend.hu/templom/${tid}`;

// The site's liturgical calendar (feast dates, Advent, clock change), shared with the browser code.
const calPath = fileURLToPath(new URL("../../calendar.js", import.meta.url));
const ctx = {}; vm.runInNewContext(fs.readFileSync(calPath, "utf8"), ctx);
export const LitCal = ctx.LitCal;

// ---- dates as day numbers (days since 1970-01-01), independent of the machine's time zone ----
export const dn = s => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); };
export const ymdOf = n => new Date(n * 864e5).toISOString().slice(0, 10);
const parts = n => { const d = new Date(n * 864e5); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay() }; };
const md = n => ymdOf(n).slice(5);
const localDn = date => Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 864e5);
const lastSunday = (y, m) => { const end = Math.round(Date.UTC(y, m, 0) / 864e5); return end - parts(end).wd; };
const adventStart = y => localDn(LitCal.adventStart(y));
const nthOfMonth = n => { const p = parts(n), dim = new Date(Date.UTC(p.y, p.m, 0)).getUTCDate(); return { nth: Math.ceil(p.d / 7), last: p.d + 7 > dim }; };

// ---- what a Mass row says besides its time: language and kind as tags, the comment parsed for more ----
const TYPE = { FAMILY: "family", csal: "family", STUDENT: "student", d: "student", UNIVERSITY_YOUTH: "university", ifi: "youth",
  GUITAR: "guitar", g: "guitar", ORGAN: "organ", SILENT: "silent", cs: "silent", SINGER: "choir", TRADITIONAL: "traditional" };
const list = s => String(s || "").split(",").map(x => x.trim()).filter(Boolean);
export function describe(row) {
  // Languages and types may carry a period suffix in v4 ("de2" = German on the 2nd week); only the code matters here.
  const p = parseNote(row.megjegyzes || "");
  const tags = new Set(p.tags);
  for (const x of list(row.nyelv)) { const t = langTag(x.replace(/[0-9\-]+$/, "").toLowerCase()); if (t) tags.add(t); }
  for (const x of list(row.milyen)) { const t = TYPE[x] || TYPE[x.replace(/[0-9\-]+$/, "")]; if (t) tags.add(t); }
  return { tags: [...tags].sort(), kind: p.kind, note: p.note };
}
const RORATE = /rorate|roráté/i;

// ---- reading the export ----
export async function readExport(file) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  const cols = db.prepare("pragma table_info(misek)").all().map(c => c.name);
  const version = cols.includes("rrule") ? 5 : 4;
  const churches = db.prepare("select * from templomok").all();
  const rows = db.prepare("select * from misek").all();
  db.close();
  return { version, churches, rows };
}

// Concrete occurrences: [{ tid, day (day number), time "HH:MM", note, rorate }] and the date window they cover.
export function occurrences({ version, rows }, today) {
  const out = []; let from = Infinity, to = -Infinity;
  // pa/pb: first and last day of the period the row belongs to (v5), so a season gets its real bounds, not just the first and last Mass.
  const desc = new Map();
  const push = (r, day, time, pa = day, pb = day) => {
    let d = desc.get(r); if (!d) { d = { ...describe(r), rorate: RORATE.test((r.megjegyzes || "") + " " + (r.idoszak || "")) }; desc.set(r, d); }
    out.push({ tid: r.tid, day, time, pa, pb, note: d.note, tags: d.tags, kind: d.kind, rorate: d.rorate });
  };
  for (const r of rows) {
    if (!r.ido) continue;
    const time = String(r.ido).slice(0, 5);
    if (version >= 5) {
      if (!r.datumtol) continue;
      const a = dn(r.datumtol), b = r.datumig ? dn(r.datumig) : a + 730;
      from = Math.min(from, a); to = Math.max(to, b);
      const ex = new Set(list(r.exdate).map(dn));
      if (!r.rrule) { if (!ex.has(a)) push(r, a, time); continue; }
      const pa = a, pb = b;
      let opts;
      try { opts = RRule.parseString(String(r.rrule).replace(/^RRULE:/i, "")); } catch { continue; }
      delete opts.until; // the period's last day (datumig) bounds it; UNTIL is in UTC and could cut a late-evening Mass
      const [hh, mm] = time.split(":").map(Number);
      const start = new Date(a * 864e5 + (hh * 60 + mm) * 6e4), end = new Date((b + 1) * 864e5 - 1);
      let dates;
      try { dates = new RRule({ ...opts, dtstart: start }).between(start, end, true); } catch { continue; }
      for (const d of dates) { const day = Math.floor(d.getTime() / 864e5); if (!ex.has(day)) push(r, day, time, pa, pb); }
    } else {
      // v4: datumtol = datumig = the single day, as (H)HNN; the year is the next such day from the export date.
      const v = Number(r.datumtol); if (!v) continue;
      const m = Math.floor(v / 100), d = v % 100, t = parts(today);
      let day = Math.round(Date.UTC(t.y, m - 1, d) / 864e5); if (day < today - 3) day = Math.round(Date.UTC(t.y + 1, m - 1, d) / 864e5);
      from = Math.min(from, day); to = Math.max(to, day);
      push(r, day, time);
    }
  }
  if (version < 5) { from = Math.min(from, today); to = Math.max(to, today + 182); }
  return { occ: out, from, to };
}

// Feasts (calendar.js keys) falling inside the window: day number → key.
export function feastDays(from, to) {
  const m = new Map();
  for (let y = parts(from).y; y <= parts(to).y; y++) for (const f of LitCal.FEASTS) { const n = localDn(f.date(y)); if (n >= from && n <= to) m.set(n, f.key); }
  return m;
}

// Season of a weekly run [s, e]: summer/winter (by the clock change), Advent (Rorate), or a date range.
function seasonOf(s, e, from, to, truncS, truncE) {
  // A weekday's first Mass of a season can fall up to 6 days after the season starts, its last up to 6 days before it ends.
  const y = parts(s).y, startsAt = (b) => s - b >= -1 && s - b <= 6, endsAt = (b) => b - (e + 1) >= -1 && b - (e + 1) <= 6;
  const springChange = yy => lastSunday(yy, 3), autumnChange = yy => lastSunday(yy, 10);
  const sNearSpring = startsAt(springChange(y)), sNearAutumn = startsAt(autumnChange(y));
  const eNearAutumn = endsAt(autumnChange(parts(e).y)), eNearSpring = endsAt(springChange(parts(e).y));
  if ((sNearSpring || truncS) && (eNearAutumn || truncE) && !(truncS && truncE)) return { period: "summer" };
  if ((sNearAutumn || truncS) && (eNearSpring || truncE) && !(truncS && truncE)) return { period: "winter" };
  if (startsAt(adventStart(y)) && md(e) >= "12-15" && md(e) <= "12-24") return { period: "advent", advent: true };
  // Seasons that move with Easter: Lent (Ash Wednesday – Holy Saturday), Eastertide (Easter – Pentecost).
  const E = localDn(LitCal.easter(y));
  if (startsAt(E - 46) && e <= E && e >= E - 8) return { period: "lent" };
  if (startsAt(E) && e >= E + 42 && e <= E + 50) return { period: "eastertide" };
  // School year (September – mid-June) and the summer holiday.
  const inMd = (n, a, b) => md(n) >= a && md(n) <= b;
  if (inMd(s, "08-28", "09-08") && inMd(e, "06-08", "06-24")) return { period: "school" };
  if (inMd(s, "06-14", "06-28") && inMd(e, "08-24", "09-01")) return { period: "holiday" };
  return { period: "all", valid: `${md(s)}/${md(e)}` };
}

// Weekly and monthly rules for one church from its occurrences.
// Returns { services: [{kind, days, start, note, period, valid, weeks, feast}], unexplained } (unexplained = one-off dates left over).
export function deriveSchedule(occ, { from, to, today }) {
  const horizon = today + 365, feasts = feastDays(from, to);
  const groups = new Map();
  for (const o of occ) {
    const wd = parts(o.day).wd, k = `${wd}|${o.time}|${o.kind || ""}|${o.tags.join(" ")}|${o.note}`;
    if (!groups.has(k)) groups.set(k, { wd, time: o.time, note: o.note, tags: o.tags, okind: o.kind, rorate: false, days: new Set(), bounds: new Map() });
    const g = groups.get(k); g.days.add(o.day); if (o.rorate) g.rorate = true;
    const b = g.bounds.get(o.day); g.bounds.set(o.day, b ? [Math.min(b[0], o.pa), Math.max(b[1], o.pb)] : [o.pa, o.pb]);
  }
  const rules = []; // { wd, time, note, kind, period, valid, weeks, s, e }
  const explained = new Set(); // "day|time"
  let unexplained = 0;
  for (const g of groups.values()) {
    const days = [...g.days].sort((a, b) => a - b), used = new Set();
    // 1. Weekly runs: consecutive weeks (one missing week at most here and there, e.g. a feast day).
    const holiday = d => feasts.has(d) || md(d) >= "12-24" || md(d) <= "01-01";
    const bridged = (a, b) => { for (let d = a + 7; d < b; d += 7) if (!holiday(d)) return false; return true; };
    const chains = []; let cur = [];
    for (const d of days) { const p = cur[cur.length - 1]; if (cur.length && d - p > 14 && !bridged(p, d)) { chains.push(cur); cur = []; } cur.push(d); }
    if (cur.length) chains.push(cur);
    const runs = [];
    const boundsOf = c => [Math.min(c[0], ...c.map(d => g.bounds.get(d)[0])), Math.max(c[c.length - 1], ...c.map(d => g.bounds.get(d)[1]))];
    for (const c of chains) {
      const expected = (c[c.length - 1] - c[0]) / 7 + 1;
      const gaps = c.slice(1).map((d, i) => d - c[i]);
      if (c.length >= 3 && c.length / expected >= 0.85) { const [s, e] = boundsOf(c); runs.push({ s, e }); c.forEach(d => used.add(d)); }
    }
    // Keep the runs that matter for the coming year; prefer complete ones to those cut off by the export's window.
    const addRuns = () => {
    const trunc = r => ({ truncS: r.s - 7 < from, truncE: r.e + 7 > to });
    const cand = runs.filter(r => r.e >= today && r.s <= horizon).map(r => {
      const t = trunc(r), whole = (t.truncS && t.truncE) || r.e - r.s >= 350;
      return { ...r, cut: t.truncS || t.truncE, season: whole ? { period: "all" } : seasonOf(r.s, r.e, from, to, t.truncS, t.truncE) };
    });
    // A run cut off by the window gives a made-up date range; skip it when a complete run says the same thing better.
    const hasFull = cand.some(r => !r.cut);
    for (const r of cand) {
      if (r.cut && hasFull && r.season.valid) continue;
      const season = r.season;
      const kind = g.okind || (season.advent && (g.rorate || g.time < "08:00") ? "rorate" : "mass");
      rules.push({ wd: g.wd, time: g.time, note: g.note, tags: g.tags, kind, period: kind === "rorate" ? "all" : season.period,
        valid: season.valid || "", weeks: [], every: r.every || null, anchor: r.every ? ymdOf(r.anchor) : null, s: r.s, e: r.e });
    }
    runs.length = 0;
    };
    addRuns();
    // 2. Nth weekday of the month ("first Friday", "last Saturday", "1st and 3rd Sunday").
    let left = days.filter(d => !used.has(d)); const left0 = left;
    if (left.length >= 2) {
      const weeks = [];
      for (const pos of [-1, 1, 2, 3, 4, 5]) {
        if (left.length < 2) break;
        const fits = d => { const n = nthOfMonth(d); return pos === -1 ? n.last : n.nth === pos; };
        const hits = left.filter(fits);
        if (hits.length < 2) continue;
        // Every month between the first and last hit should have it.
        let months = 0;
        for (let d = hits[0]; d <= hits[hits.length - 1]; d += 7) if (parts(d).wd === g.wd && fits(d)) months++;
        if (hits.length / months >= 0.75) { weeks.push(pos); hits.forEach(d => used.add(d)); left = left.filter(d => !hits.includes(d)); }
      }
      if (weeks.length) {
        const hs = left0.filter(d => used.has(d));
        const s = hs[0], e = hs[hs.length - 1];
        const whole = (s - 35 < from && e + 35 > to) || e - s >= 300;
        rules.push({ wd: g.wd, time: g.time, note: g.note, tags: g.tags, kind: g.okind || "mass", period: "all", valid: whole ? "" : `${md(s)}/${md(e)}`,
          weeks: weeks.sort((a, b) => (a < 0) - (b < 0) || a - b), every: null, anchor: null, s, e });
      }
    }
    // 3. Every 2nd, 3rd or 4th week, counted from one of its dates (holiday gaps bridged).
    for (const k of [2, 3, 4]) {
      const step = 7 * k, rest = days.filter(d => !used.has(d));
      let seq = [];
      const flush = () => {
        if (seq.length >= 4) { const [s, e] = boundsOf(seq); runs.push({ s, e, every: k, anchor: seq.find(d => d >= today) ?? seq[seq.length - 1] }); seq.forEach(d => used.add(d)); }
        seq = [];
      };
      for (const d of rest) {
        const p = seq[seq.length - 1];
        if (seq.length && !(d - p === step || ((d - p) % step === 0 && d - p <= 3 * step && bridged(p, d)))) flush();
        seq.push(d);
      }
      flush();
    }
    // A fortnightly rule counted in ISO weeks slips a week at New Year; keep only the stretch that covers the coming months.
    if (runs.some(r => r.every)) { const now = runs.filter(r => r.every && r.e >= today).sort((a, b) => a.s - b.s)[0]; runs.splice(0, runs.length, ...(now ? [now] : [])); }
    addRuns();
    for (const d of days) if (used.has(d)) explained.add(d + "|" + g.time); else if (!feasts.has(d)) unexplained++;
  }

  // 4. Feast days: if what happens that day differs from the regular rules, it becomes the feast's own schedule.
  const regularOn = d => {
    const p = parts(d);
    const advent = LitCal.inAdvent(new Date(p.y, p.m - 1, p.d));
    const date = new Date(p.y, p.m - 1, p.d);
    return rules.filter(r => r.wd === p.wd && (r.kind !== "rorate" || advent) && LitCal.inPeriod(date, r.period, r.valid)
      && (!r.weeks.length || LitCal.weekOk(date, r.weeks)) && LitCal.everyOk(date, r.every, r.anchor))
      .map(r => r.time).filter((t, i, all) => all.indexOf(t) === i).sort().join(",");
  };
  const feastSvc = [], doneFeast = new Set();
  for (const [d, key] of [...feasts].sort((a, b) => a[0] - b[0])) {
    if (d < today || doneFeast.has(key)) continue;
    doneFeast.add(key);
    const that = occ.filter(o => o.day === d);
    if (!that.length) continue;
    const times = [...new Set(that.map(o => o.time))].sort().join(",");
    if (times === regularOn(d)) continue;
    const seen = new Set();
    for (const o of that.sort((a, b) => a.time.localeCompare(b.time))) {
      if (seen.has(o.time + o.note + o.tags)) continue; seen.add(o.time + o.note + o.tags);
      feastSvc.push({ kind: o.kind || "mass", days: [], start: o.time, note: o.note, tags: o.tags, period: "all", feast: key, valid: "", weeks: [], every: null, anchor: null });
    }
  }

  // 5. Merge rules that differ only in the weekday into one row.
  const merged = new Map();
  for (const r of rules) {
    // Wording the rule now says itself ("kéthetente", "elsőpénteken") leaves the note.
    const pn = parseNote(r.note, { every: r.every, weeks: r.weeks.length > 0 });
    const tags = [...new Set([...r.tags, ...pn.tags])].sort(), note = pn.note;
    // Anchors of rows on different weekdays differ; the earliest day of that week keeps them in step.
    const k = [r.kind, r.time, note, tags.join(" "), r.period, r.valid, r.weeks.join("."), r.every || ""].join("|");
    if (!merged.has(k)) merged.set(k, { kind: r.kind, days: [], start: r.time, note, tags, period: r.period, valid: r.valid, weeks: r.weeks, every: r.every, anchor: r.anchor, feast: null });
    const m = merged.get(k); if (!m.days.includes(r.wd)) m.days.push(r.wd);
  }
  const services = [...merged.values()].map(s => ({ ...s, days: s.days.sort((a, b) => a - b) }))
    .sort((a, b) => a.days[0] - b.days[0] || a.start.localeCompare(b.start)).concat(feastSvc);
  return { services, unexplained };
}
