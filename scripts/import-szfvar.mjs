// Imports the Mass schedule of the Diocese of Székesfehérvár into Supabase.
// Runs in GitHub Actions (.github/workflows/import-szfvar.yml).
//
// 1. Downloads https://www.szfvar.katolikus.hu/adattar/miserend and parses every church on it.
// 2. Finds each church in the database (by settlement location and the church's name), or adds it at the
//    settlement centre, marked "hely pontosítandó".
// 3. Replaces the regular times of churches whose times are empty or came from this import before.
//    Churches with hand-entered times or locked by an editor are skipped (FORCE=1 overrides hand-entered ones).
// Writes a report to the job summary and report.json.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEY   Optional: DRY_RUN=1, FORCE=1, SOURCE_HTML=<local file instead of downloading>
import fs from "fs";
import { extractEntries, parseEntry, churchNameFor, fold, SOURCE, SOURCE_NAME, SOURCE_URL } from "./lib/szfvar.mjs";
import { placeIndex, anchorFor, candidatePairs, looksLikeSameBuilding } from "./lib/match.mjs";
import { overpass } from "./import-osm.mjs";

const url = (process.env.SUPABASE_URL || "").replace(/\/$/, ""), key = process.env.SUPABASE_SECRET_KEY || "";
const DRY = process.env.DRY_RUN === "1", FORCE = process.env.FORCE === "1";
const H = () => ({ apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" });
const BBOX = { s: 46.6, n: 47.95, w: 17.6, e: 19.4 };   // generous box around the diocese
const IMPORTANCE = { parish: 45, directorate: 40, filia: 25, place: 15 };

async function api(path, opts = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, { ...opts, headers: { ...H(), ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path.split("?")[0]} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}
async function loadChurches() {
  const out = [];
  const sel = "id,name,city,lat,lon,osm_type,osm_id,schedule_source,source_ref,schedule_locked,match_confirmed,created_by,location_approx," +
    "services(count),events(count),suggestions(count),opening_hours(count)";
  for (let from = 0; ; from += 1000) {
    const page = await api(`churches?select=${sel}&lat=gte.${BBOX.s}&lat=lte.${BBOX.n}&lon=gte.${BBOX.w}&lon=lte.${BBOX.e}&order=id`,
      { headers: { Range: `${from}-${from + 999}`, "Range-Unit": "items" } });
    for (const c of page) { for (const k of ["services", "events", "suggestions", "opening_hours"]) c[k] = c[k]?.[0]?.count ?? 0; out.push(c); }
    if (page.length < 1000) return out;
  }
}
// Other names OpenStreetMap knows for the churches (alt_name, old_name, official_name…), to help matching.
const CHURCH_NAMES_QUERY = `[out:json][timeout:180];
nwr["amenity"="place_of_worship"]["religion"="christian"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
out tags;`;
const PLACE_QUERY = `[out:json][timeout:180];
area["ISO3166-1"="HU"][admin_level=2]->.hu;
node["place"~"^(city|town|village|suburb|quarter|neighbourhood|hamlet|isolated_dwelling|locality)$"]["name"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
out;`;

async function main() {
  if (!DRY && (!url || !key)) throw new Error("Set the SUPABASE_URL and SUPABASE_SECRET_KEY repository secrets first.");
  console.log(`Downloading ${SOURCE_URL} …`);
  const html = process.env.SOURCE_HTML ? fs.readFileSync(process.env.SOURCE_HTML, "utf8")
    : await (await fetch(SOURCE_URL, { headers: { "User-Agent": "harangszo-import (github.com/szbaliint/harangszo)" } })).text();
  const entries = extractEntries(html).map(parseEntry);
  console.log(`Parsed ${entries.length} churches; ${entries.filter(e => e.services.length).length} with times.`);
  if (entries.length < Number(process.env.MIN_ENTRIES || 50)) throw new Error("Too few churches found; the page layout may have changed. Nothing was written.");

  console.log("Downloading place and church names from OpenStreetMap…");
  const places = placeIndex(await overpass(PLACE_QUERY));
  const osmNames = new Map();
  try {
    for (const el of await overpass(CHURCH_NAMES_QUERY)) {
      const t = el.tags || {}; const names = [t.alt_name, t.old_name, t.official_name, t["name:hu"], t.short_name, t.loc_name].filter(Boolean).flatMap(n => n.split(";"));
      if (names.length) osmNames.set(el.type + "/" + el.id, names);
    }
  } catch (err) { console.warn("Could not download OpenStreetMap alternative names; matching uses the main names only.", err.message); }
  const churches = url && key ? await loadChurches() : [];
  for (const c of churches) c.altNames = osmNames.get(c.osm_type + "/" + c.osm_id) || [];
  console.log(`${churches.length} churches in the database around the diocese.`);

  // Previous imports: which church holds which entry.
  const holderOf = new Map(churches.filter(c => c.schedule_source === SOURCE && c.source_ref).map(c => [c.source_ref, c]));
  const importMade = c => c.created_by === SOURCE && c.osm_id == null;
  // Churches eligible for automatic matching: everything except churches this import created itself.
  const pool = churches.filter(c => !importMade(c));
  const report = entries.map(e => ({ ref: fold(e.title).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), e, anchor: anchorFor(e, places), m: null, fix: null, result: null }));
  for (const r of report) r.holder = holderOf.get(r.ref) || null;

  // 1. Matches an editor confirmed (by merging) or locked stay as they are.
  const taken = new Set();
  for (const r of report) if (r.holder && (r.holder.match_confirmed || r.holder.schedule_locked)) { r.m = { church: r.holder, how: "confirmed", score: 99, dist: 0 }; taken.add(r.holder.id); }
  // 2. Everything else is matched again, best pairs first, so earlier mistakes get corrected.
  const pairs = [];
  for (const r of report) if (!r.m) for (const p of candidatePairs(r.e, r.anchor, pool)) pairs.push({ r, p });
  pairs.sort((a, b) => b.p.score - a.p.score);
  for (const { r, p } of pairs) { if (r.m || taken.has(p.church.id)) continue; r.m = p; taken.add(p.church.id); }
  // 3. No match: keep using the church a previous run created for this entry.
  for (const r of report) if (!r.m && r.holder && !taken.has(r.holder.id)) { r.m = { church: r.holder, how: "earlier-import", score: 0, dist: 0 }; taken.add(r.holder.id); }
  // Earlier, now superseded, holders get released (their imported times removed; churches the import made are deleted).
  for (const r of report) if (r.holder && r.m && r.m.church.id !== r.holder.id) r.fix = r.holder;

  // Two OpenStreetMap objects for the same building next to a matched church (node + outline): merge them.
  const dupes = [];
  for (const r of report) {
    if (!r.m || r.m.church.osm_id == null) continue;
    for (const c of churches) {
      if (c.id === r.m.church.id || taken.has(c.id) || c.osm_id == null || c.schedule_locked || c.match_confirmed) continue;
      if (c.services || c.events || c.suggestions || c.opening_hours || c.source_ref) continue;
      if (looksLikeSameBuilding(r.m.church, c)) { dupes.push({ keep: r.m.church, drop: c, r }); taken.add(c.id); }
    }
  }

  let created = 0, updated = 0, skipped = 0, released = 0, merged = 0;
  if (!DRY) {
    for (const r of report) if (r.fix) { r.fixResult = await api("rpc/release_imported_church", { method: "POST", body: JSON.stringify({ cid: r.fix.id, src: SOURCE }) }); released++; }
    for (const d of dupes) { await api("rpc/merge_churches", { method: "POST", body: JSON.stringify({ keep_id: d.keep.id, drop_id: d.drop.id, schedule_from: "keep", name_from: "keep" }) }); merged++; }
  }
  for (const r of report) {
    const { e, anchor } = r;
    if (!r.m && !anchor) { r.result = "no-location"; continue; }
    if (!e.services.length && !e.note) { r.result = "no-data"; continue; }
    if (DRY) { r.result = r.m ? "would-update" : "would-create"; continue; }
    let id = r.m?.church.id;
    if (!id) {
      const [row] = await api("churches", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({
        name: churchNameFor(e), city: e.settlement, address: e.district || "", rite: /görög/i.test(e.title) ? "gk" : "rk",
        lat: +anchor.lat.toFixed(6), lon: +anchor.lon.toFixed(6), location_approx: true, importance_auto: IMPORTANCE[e.type] ?? 30,
        schedule_source: SOURCE, source_ref: r.ref, created_by: SOURCE,
        notes: `Importálva: ${SOURCE_NAME} miserendje (${e.title}). A hely a(z) ${anchor.name} ${anchor.level === "district" ? "városrész" : "település"} közepe — pontosítsd a térképen, vagy vond össze a valódi templommal.` }) });
      id = row.id; created++;
    }
    const res = await api("rpc/import_church_schedule", { method: "POST", body: JSON.stringify({ p: {
      church_id: id, source: SOURCE, source_url: SOURCE_URL, source_ref: r.ref, updated: e.updated, note: e.note, force: FORCE,
      city: e.settlement, address: e.district || "",
      services: e.services.map(s => ({ kind: s.kind, days: s.days, start: s.start, end: s.end || "", note: s.note || "", period: s.period,
        feast: s.feast, valid: s.valid || "", weeks: s.weeks || [] })) } }) });
    r.result = res; if (res === "updated") updated++; else skipped++;
  }

  // Report
  const label = { "earlier-import": "korábbi import", confirmed: "szerkesztő által megerősítve", name: "név alapján", hint: "városrész / plébánia címe alapján", "only-church": "egyetlen templom a közelben" };
  const lines = [`# ${SOURCE_NAME} – miserend import${DRY ? " (próbafuttatás)" : ""}`, "",
    `Feldolgozva: **${entries.length}** misézőhely. ${DRY ? `Párosítva lenne: ${report.filter(r => r.result === "would-update").length}, új templom lenne: ${report.filter(r => r.result === "would-create").length}, javított korábbi párosítás: ${report.filter(r => r.fix).length}, összevonandó OSM-duplikátum: ${dupes.length}.` : `Frissítve: **${updated}**, új templom: **${created}**, kihagyva: **${skipped}**, javított korábbi párosítás: **${released}**, összevont duplikátum: **${merged}**.`}`, "",
    "| Forrás | Eredmény | Templom az adatbázisban | Párosítás | Időpontok | Javítás |", "|---|---|---|---|---|---|"];
  const RES = { updated: "frissítve", manual: "kihagyva: kézzel felvitt időpontok", locked: "kihagyva: zárolva", missing: "hiba: nincs ilyen templom",
    "no-location": "kihagyva: a település nem található", "no-data": "nincs időpont", "would-update": "frissülne", "would-create": "új templom lenne" };
  for (const r of report) {
    const t = r.m ? `${r.m.church.name} (${r.m.church.city || "–"})` : r.anchor ? `új: ${churchNameFor(r.e)} @ ${r.anchor.name}` : "–";
    const how = r.m ? `${label[r.m.how] || r.m.how}${r.m.dist ? `, ${r.m.dist.toFixed(1)} km` : ""}` : "";
    const fixT = r.fix ? `korábban: ${r.fix.name} (${r.fixResult === "deleted" ? "törölve" : r.fixResult === "cleared" ? "időpontjai törölve" : DRY ? "javítandó" : r.fixResult})` : "";
    lines.push(`| ${r.e.title.replace(/\|/g, "/")} | ${RES[r.result] || r.result} | ${t.replace(/\|/g, "/")} | ${how} | ${r.e.services.length} | ${fixT.replace(/\|/g, "/")} |`);
  }
  if (dupes.length) { lines.push("", "### Összevont OpenStreetMap-duplikátumok", "");
    for (const d of dupes) lines.push(`- ${d.drop.name} → ${d.keep.name} (${(Math.round(1000 * Math.hypot((d.keep.lat - d.drop.lat) * 111, (d.keep.lon - d.drop.lon) * 75)))} m)${DRY ? " — próbafuttatás, nem történt meg" : ""}`); }
  const md = lines.join("\n");
  fs.writeFileSync("report.md", md);
  fs.writeFileSync("report.json", JSON.stringify(report.map(r => ({ title: r.e.title, result: r.result, church: r.m?.church ?? null, how: r.m?.how ?? null,
    anchor: r.anchor, services: r.e.services, note: r.e.note, updated: r.e.updated })), null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  console.log(md.split("\n").slice(0, 4).join("\n"));
}

main().catch(e => { console.error("Import failed:", e.message); process.exit(1); });
