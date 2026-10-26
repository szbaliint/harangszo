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
import { placeIndex, anchorFor, matchChurch } from "./lib/match.mjs";
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
  for (let from = 0; ; from += 1000) {
    const page = await api(`churches?select=id,name,city,lat,lon,schedule_source,source_ref,schedule_locked&lat=gte.${BBOX.s}&lat=lte.${BBOX.n}&lon=gte.${BBOX.w}&lon=lte.${BBOX.e}&order=id`,
      { headers: { Range: `${from}-${from + 999}`, "Range-Unit": "items" } });
    out.push(...page); if (page.length < 1000) return out;
  }
}
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

  console.log("Downloading place names from OpenStreetMap…");
  const places = placeIndex(await overpass(PLACE_QUERY));
  const churches = url && key ? await loadChurches() : [];
  console.log(`${churches.length} churches in the database around the diocese.`);

  const bySourceRef = new Map(churches.filter(c => c.schedule_source === SOURCE && c.source_ref).map(c => [c.source_ref, c]));
  const claimed = new Set(), report = [];
  for (const e of entries) {
    const ref = fold(e.title).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const anchor = anchorFor(e, places);
    let m = bySourceRef.get(ref) ? { church: bySourceRef.get(ref), how: "earlier-import", sim: 1, dist: 0 } : matchChurch(e, anchor, churches, claimed);
    if (m) claimed.add(m.church.id);
    report.push({ ref, e, anchor, m, result: null });
  }

  let created = 0, updated = 0, skipped = 0;
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
        schedule_source: SOURCE, source_ref: r.ref,
        notes: `Importálva: ${SOURCE_NAME} miserendje (${e.title}). A hely a(z) ${anchor.name} ${anchor.level === "district" ? "városrész" : "település"} közepe — pontosítsd a térképen.` }) });
      id = row.id; created++;
    } else if (!r.m.church.source_ref) {
      await api(`churches?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ source_ref: r.ref }) });
    }
    const res = await api("rpc/import_church_schedule", { method: "POST", body: JSON.stringify({ p: {
      church_id: id, source: SOURCE, source_url: SOURCE_URL + (e.href ? "" : ""), updated: e.updated, note: e.note, force: FORCE,
      services: e.services.map(s => ({ kind: s.kind, days: s.days, start: s.start, end: s.end || "", note: s.note || "", period: s.period, feast: s.feast })) } }) });
    r.result = res; if (res === "updated") updated++; else skipped++;
  }

  // Report
  const label = { "earlier-import": "korábbi import", name: "név alapján", "only-church": "egyetlen templom a közelben" };
  const lines = [`# ${SOURCE_NAME} – miserend import${DRY ? " (próbafuttatás)" : ""}`, "",
    `Feldolgozva: **${entries.length}** misézőhely. ${DRY ? `Párosítva lenne: ${report.filter(r => r.result === "would-update").length}, új templom lenne: ${report.filter(r => r.result === "would-create").length}.` : `Frissítve: **${updated}**, új templom: **${created}**, kihagyva: **${skipped}**.`}`, "",
    "| Forrás | Eredmény | Templom az adatbázisban | Párosítás | Időpontok |", "|---|---|---|---|---|"];
  const RES = { updated: "frissítve", manual: "kihagyva: kézzel felvitt időpontok", locked: "kihagyva: zárolva", missing: "hiba: nincs ilyen templom",
    "no-location": "kihagyva: a település nem található", "no-data": "nincs időpont", "would-update": "frissülne", "would-create": "új templom lenne" };
  for (const r of report) {
    const t = r.m ? `${r.m.church.name} (${r.m.church.city || "–"})` : r.anchor ? `új: ${churchNameFor(r.e)} @ ${r.anchor.name}` : "–";
    const how = r.m ? `${label[r.m.how] || r.m.how}${r.m.dist ? `, ${r.m.dist.toFixed(1)} km` : ""}` : "";
    lines.push(`| ${r.e.title.replace(/\|/g, "/")} | ${RES[r.result] || r.result} | ${t.replace(/\|/g, "/")} | ${how} | ${r.e.services.length} |`);
  }
  const md = lines.join("\n");
  fs.writeFileSync("report.md", md);
  fs.writeFileSync("report.json", JSON.stringify(report.map(r => ({ title: r.e.title, result: r.result, church: r.m?.church ?? null, how: r.m?.how ?? null,
    anchor: r.anchor, services: r.e.services, note: r.e.note, updated: r.e.updated })), null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  console.log(md.split("\n").slice(0, 4).join("\n"));
}

main().catch(e => { console.error("Import failed:", e.message); process.exit(1); });
