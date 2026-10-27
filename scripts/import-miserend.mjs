// Imports Mass times for churches in Hungary from miserend.hu into Supabase.
// Runs in GitHub Actions (.github/workflows/import-miserend.yml).
//
// 1. Downloads miserend.hu's SQLite export (v5 with recurrence rules if available, else v4) — see https://miserend.hu/apidocs.
// 2. Turns each church's concrete Mass dates into weekly rules, seasons and feast-day schedules (lib/miserend.mjs).
// 3. Finds the church in the database by its exact location and name, or adds it.
// 4. Replaces the regular times of churches whose times are empty or came from miserend.hu before.
//    Churches with hand-entered times or locked by an editor are skipped (FORCE=1 overrides hand-entered ones);
//    churches whose times come from a diocese's own import (e.g. Székesfehérvár) are always left to that import.
// Writes a report to the job summary, report.md and report.json.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEY
// Optional: DRY_RUN=1, FORCE=1, SOURCE_FILE=<local .sqlite3 instead of downloading>, MISEREND_VERSION=4|5, LIMIT=<n churches, for testing>
import fs from "fs";
import { readExport, occurrences, deriveSchedule, dn, ymdOf, SOURCE, SOURCE_NAME, churchUrl } from "./lib/miserend.mjs";
import { nameSim, km, tokens } from "./lib/match.mjs";
import { fold } from "./lib/szfvar.mjs";

const url = (process.env.SUPABASE_URL || "").replace(/\/$/, ""), key = process.env.SUPABASE_SECRET_KEY || "";
const DRY = process.env.DRY_RUN === "1", FORCE = process.env.FORCE === "1";
const H = () => ({ apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" });
const UA = { "User-Agent": "harangszo-import (https://github.com/szbaliint/harangszo)" };
const HU = { s: 45.7, n: 48.6, w: 16.1, e: 22.95 };
const today = dn(new Date().toISOString());

async function api(path, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${url}/rest/v1/${path}`, { ...opts, headers: { ...H(), ...(opts.headers || {}) } });
    if (res.ok) { const t = await res.text(); return t ? JSON.parse(t) : null; }
    const body = (await res.text()).slice(0, 300);
    if ((res.status >= 500 || res.status === 429) && attempt < 3) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
    throw new Error(`${opts.method || "GET"} ${path.split("?")[0]} → HTTP ${res.status}: ${body}`);
  }
}

// ---- 1. the export ----
async function download() {
  if (process.env.SOURCE_FILE) return process.env.SOURCE_FILE;
  const versions = process.env.MISEREND_VERSION ? [Number(process.env.MISEREND_VERSION)] : [5, 4];
  for (const v of versions) {
    const u = `https://miserend.hu/api/v${v}/sqlite`;
    try {
      console.log(`Downloading ${u} …`);
      const res = await fetch(u, { headers: UA, redirect: "follow" });
      if (!res.ok) { console.warn(`  HTTP ${res.status}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.subarray(0, 16).toString("latin1") !== "SQLite format 3\0") { console.warn("  not an SQLite file"); continue; }
      const f = `miserend_v${v}.sqlite3`; fs.writeFileSync(f, buf);
      console.log(`  ${(buf.length / 1048576).toFixed(1)} MB`);
      return f;
    } catch (err) { console.warn(`  ${err.message}`); }
  }
  throw new Error("Could not download the miserend.hu export. Nothing was written.");
}

// ---- 3. the database ----
async function loadChurches() {
  const out = [];
  const sel = "id,name,city,address,lat,lon,osm_id,schedule_source,source_ref,schedule_locked,match_confirmed,created_by,location_approx,services(count)";
  for (let from = 0; ; from += 1000) {
    const page = await api(`churches?select=${sel}&order=id`, { headers: { Range: `${from}-${from + 999}`, "Range-Unit": "items" } });
    for (const c of page) { c.services = c.services?.[0]?.count ?? 0; out.push(c); }
    if (page.length < 1000) return out;
  }
}
// Grid of churches by ~1 km cells, for fast "what is near here".
function grid(churches) {
  const g = new Map(), cell = (lat, lon) => `${Math.floor(lat * 100)}|${Math.floor(lon * 70)}`;
  for (const c of churches) { const k = cell(c.lat, c.lon); if (!g.has(k)) g.set(k, []); g.get(k).push(c); }
  return (lat, lon, r = 1) => {
    const out = [], a = Math.floor(lat * 100), b = Math.floor(lon * 70);
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) out.push(...(g.get(`${a + i}|${b + j}`) || []));
    return out;
  };
}
const sim = (m, c) => Math.max(nameSim(m.nev, c.name), m.ismertnev ? nameSim(m.ismertnev, c.name) : 0, nameSim(c.name, m.nev));

// Candidate churches for one miserend.hu church, best first.
function candidates(m, near, approxByCity) {
  const out = [];
  const list = near(m.lat, m.lng, 1);
  const close = list.map(c => ({ c, d: km(m.lat, m.lng, c.lat, c.lon) })).filter(x => x.d <= 0.4);
  for (const { c, d } of close) {
    const s = sim(m, c);
    const ok = d <= 0.05 || (s >= 0.5 && d <= 0.4) || (d <= 0.15 && close.filter(x => x.d <= 0.15).length === 1 && (s > 0 || !tokens(c.name).length));
    if (ok) out.push({ church: c, how: d <= 0.05 ? "same-place" : s >= 0.5 ? "name" : "only-church", score: 2 * s - 4 * d + (d <= 0.05 ? 1 : 0), dist: d });
  }
  // Churches a diocese import placed at the settlement centre ("hely pontosítandó"): same town, similar name.
  for (const c of approxByCity.get(fold(m.varos || "")) || []) {
    const d = km(m.lat, m.lng, c.lat, c.lon), s = sim(m, c);
    if (d <= 15 && s >= 0.6) out.push({ church: c, how: "approx-place", score: 2 * s - 0.05 * d, dist: d });
  }
  return out.sort((a, b) => b.score - a.score);
}

const importanceOf = name => { const f = fold(name); return /szekesegyhaz|bazilika|kegytemplom/.test(f) ? 70 : /kapolna|otthon|korhaz|iskola|temeto/.test(f) ? 15 : 30; };

async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); })); }

async function main() {
  if (!DRY && (!url || !key)) throw new Error("Set the SUPABASE_URL and SUPABASE_SECRET_KEY repository secrets first.");
  const file = await download();
  const ex = await readExport(file);
  const inHu = c => (c.orszag ? /magyarorsz/i.test(c.orszag) : true) && c.lat >= HU.s && c.lat <= HU.n && c.lng >= HU.w && c.lng <= HU.e;
  let mChurches = ex.churches.filter(c => inHu(c) && c.lat && c.lng);
  if (process.env.LIMIT) mChurches = mChurches.slice(0, Number(process.env.LIMIT));
  console.log(`Export v${ex.version}: ${ex.churches.length} churches (${mChurches.length} in Hungary), ${ex.rows.length} Mass rows.`);
  if (mChurches.length < Number(process.env.MIN_CHURCHES || 1000)) throw new Error("Too few churches in the export; its format may have changed. Nothing was written.");

  const { occ, from, to } = occurrences(ex, today);
  const byTid = new Map(); for (const o of occ) { if (!byTid.has(o.tid)) byTid.set(o.tid, []); byTid.get(o.tid).push(o); }
  console.log(`${occ.length} Mass dates between ${ymdOf(from)} and ${ymdOf(to)}.`);

  const churches = url && key ? await loadChurches() : [];
  console.log(`${churches.length} churches in the database.`);
  const holderOf = new Map(churches.filter(c => c.source_ref && (c.schedule_source === SOURCE || c.created_by === SOURCE)).map(c => [String(c.source_ref), c]));
  const held = new Set([...holderOf.values()].map(c => c.id));
  const free = churches.filter(c => !held.has(c.id));
  const near = grid(free);
  const approxByCity = new Map();
  for (const c of free) if (c.location_approx && c.created_by) { const k = fold(c.city || ""); if (!approxByCity.has(k)) approxByCity.set(k, []); approxByCity.get(k).push(c); }

  // Match: churches imported before keep their church; the others are paired best-first, one church each.
  const report = mChurches.map(m => {
    const d = deriveSchedule(byTid.get(m.tid) || [], { from, to, today });
    return { m, ref: String(m.tid), services: d.services, unexplained: d.unexplained, match: null, result: null };
  });
  const taken = new Set();
  for (const r of report) { const h = holderOf.get(r.ref); if (h) { r.match = { church: h, how: "earlier-import", dist: km(r.m.lat, r.m.lng, h.lat, h.lon) }; taken.add(h.id); } }
  const pairs = [];
  for (const r of report) if (!r.match) for (const p of candidates(r.m, near, approxByCity)) pairs.push({ r, p });
  pairs.sort((a, b) => b.p.score - a.p.score);
  for (const { r, p } of pairs) { if (r.match || taken.has(p.church.id)) continue; r.match = p; taken.add(p.church.id); }

  let updated = 0, created = 0, skipped = 0, moved = 0, failed = 0;
  const work = report.filter(r => r.services.length);
  for (const r of report) if (!r.services.length) r.result = "no-times";
  await pool(work, DRY ? 1 : 6, async r => {
    const { m } = r, c = r.match?.church;
    try {
      // A diocese's own import knows better: leave its times, but take the exact location if it only had the settlement's.
      if (c && c.schedule_source && c.schedule_source !== SOURCE) {
        r.result = "other-source";
        if (c.location_approx && r.match.how === "approx-place") {
          if (!DRY) await api(`churches?id=eq.${c.id}`, { method: "PATCH", body: JSON.stringify({ lat: +m.lat.toFixed(6), lon: +m.lng.toFixed(6), location_approx: false }) });
          r.moved = true; moved++;
        }
        skipped++; return;
      }
      if (DRY) { r.result = c ? "would-update" : "would-create"; return; }
      let id = c?.id;
      if (!id) {
        const [row] = await api("churches", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({
          name: m.nev, city: (m.varos || "").replace(/\s*\(.*\)$/, ""), address: m.cim || "", rite: m.gorog ? "gk" : "rk",
          lat: +m.lat.toFixed(6), lon: +m.lng.toFixed(6), importance_auto: importanceOf(m.nev),
          schedule_source: SOURCE, source_ref: r.ref, created_by: SOURCE, notes: `Importálva: ${SOURCE_NAME} (${churchUrl(m.tid)})` }) });
        id = row.id; created++; r.created = true;
      }
      if (c?.location_approx && r.match.how === "approx-place")
        await api(`churches?id=eq.${c.id}`, { method: "PATCH", body: JSON.stringify({ lat: +m.lat.toFixed(6), lon: +m.lng.toFixed(6), location_approx: false }) });
      const res = await api("rpc/import_church_schedule", { method: "POST", body: JSON.stringify({ p: {
        church_id: id, source: SOURCE, source_url: churchUrl(m.tid), source_ref: r.ref, updated: ymdOf(today), note: "", force: FORCE,
        city: (m.varos || "").replace(/\s*\(.*\)$/, ""), address: m.cim || "",
        services: r.services.map(s => ({ kind: s.kind, days: s.days, start: s.start, end: "", note: s.note || "", period: s.period,
          feast: s.feast, valid: s.valid || "", weeks: s.weeks || [] })) } }) });
      r.result = res; if (res === "updated") updated++; else skipped++;
    } catch (err) {
      r.result = "error"; r.error = err.message.slice(0, 200); failed++;
      console.error(`${m.nev} (${m.tid}): ${r.error}`);
    }
  });

  // ---- report ----
  const RES = { error: "HIBA", updated: "frissítve", manual: "kihagyva (kézzel felvitt időpontok)", locked: "kihagyva (zárolt)", missing: "nincs ilyen templom",
    "no-times": "nincs időpont", "other-source": "kihagyva (egyházmegyei import)", "would-update": "frissülne", "would-create": "új templom lenne" };
  const count = k => report.filter(r => r.result === k).length;
  const fmt = s => `${s.feast ? "[" + s.feast + "] " : ""}${s.kind === "rorate" ? "Rorate " : ""}${s.days.map(d => ["V", "H", "K", "Sze", "Cs", "P", "Szo"][d]).join(",")} ${s.start}${s.period !== "all" ? " " + (s.period === "summer" ? "nyáron" : "télen") : ""}${s.valid ? " " + s.valid : ""}${s.weeks?.length ? " (" + s.weeks.map(w => w === -1 ? "utolsó" : w + ".").join(",") + " hét)" : ""}`;
  const head = [`# ${SOURCE_NAME} – miserend import${DRY ? " (próbafuttatás)" : ""}`, "",
    `Export: v${ex.version}, ${mChurches.length} magyarországi templom, időpontok ${ymdOf(from)} – ${ymdOf(to)}.`, "",
    DRY ? `Frissülne: **${count("would-update")}**, új templom lenne: **${count("would-create")}**, egyházmegyei import miatt kihagyva: **${count("other-source")}** (ebből pontos helyet kapna: ${moved}), időpont nélkül: ${count("no-times")}.`
      : `Frissítve: **${updated}**, ebből új templom: **${created}**, kihagyva: **${skipped}** (kézzel felvitt: ${count("manual")}, zárolt: ${count("locked")}, egyházmegyei import: ${count("other-source")}), pontos helyet kapott: ${moved}, időpont nélkül: ${count("no-times")}${failed ? `, **hiba: ${failed}**` : ""}.`,
    "", `Egyszeri, szabályba nem illő alkalmak (kimaradtak): ${report.reduce((n, r) => n + r.unexplained, 0)}.`];
  const rows = report.filter(r => r.result !== "no-times").map(r => `| [${r.m.nev}](${churchUrl(r.m.tid)}) | ${r.m.varos || ""} | ${r.match ? `${r.match.church.name} (#${r.match.church.id}, ${Math.round(r.match.dist * 1000)} m, ${r.match.how})` : "—"} | ${RES[r.result] || r.result}${r.error ? ": " + r.error : ""} | ${r.services.map(fmt).join("; ")} |`);
  const table = ["", "| miserend.hu | Település | Templom az adatbázisban | Eredmény | Időpontok |", "|---|---|---|---|---|"];
  const errs = report.filter(r => r.result === "error").map(r => `- ${r.m.nev} (${r.m.tid}): ${r.error}`);
  const md = [...head, ...(errs.length ? ["", "### Hibák", ...errs] : []), ...table, ...rows].join("\n");
  fs.writeFileSync("report.md", md + "\n");
  fs.writeFileSync("report.json", JSON.stringify(report.map(r => ({ tid: r.m.tid, name: r.m.nev, city: r.m.varos, result: r.result, error: r.error,
    church: r.match ? { id: r.match.church.id, name: r.match.church.name, how: r.match.how, dist_m: Math.round(r.match.dist * 1000) } : null,
    created: !!r.created, services: r.services, unexplained: r.unexplained })), null, 1));
  // The job summary has a size limit: counts, errors and the first rows; the full table is in the report artifact.
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    [...head, ...(errs.length ? ["", "### Hibák", ...errs.slice(0, 50)] : []), "", "A teljes lista a futás **report** mellékletében (report.md).", ...table, ...rows.slice(0, 300)].join("\n") + "\n");
  console.log(head.join("\n"));
  if (failed) { console.error(`${failed} churches failed; see the report.`); process.exitCode = 1; }
}

main().catch(err => { console.error("Import failed:", err.message); process.exit(1); });
