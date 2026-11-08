// Imports the weekly Mass and confession schedule of the Pest Franciscans (Budapest, Ferenciek tere) from
// https://pestiferencesek.hu/miserend/ (a PDF that changes every week) into dated_services.
// On the dates it covers, those times replace the church's regular rules on the public site.
// Runs in GitHub Actions every day (.github/workflows/import-ferences.yml); a run with nothing new changes nothing.
// Who celebrates each Mass is stored (as on the parish's own public schedule); Mass intentions and the confessors' names are never read.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEY   Optional: DRY_RUN=1, SOURCE_PDF=<local file>, PDF_URL=<url>, CHURCH_ID=<id>
import fs from "fs";
import { parseWeek, pdfItems } from "./lib/ferences.mjs";

const SITE = "https://pestiferencesek.hu", PAGE = `${SITE}/miserend/`, SOURCE = "pestiferencesek";
const CHURCH = { lat: 47.49320, lon: 19.05647, name: /ferenc|alc[aá]ntara|szent p[eé]ter/i };
const url = (process.env.SUPABASE_URL || "").replace(/\/$/, ""), key = process.env.SUPABASE_SECRET_KEY || "";
const DRY = process.env.DRY_RUN === "1";
const H = () => ({ apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" });
const UA = { "User-Agent": "harangszo-import (https://github.com/szbaliint/harangszo)" };

async function api(path, opts = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, { ...opts, headers: { ...H(), ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path.split("?")[0]} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}
const isoWeek = d => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return { y: t.getUTCFullYear(), w: Math.ceil(((t - y0) / 864e5 + 1) / 7) }; };
const weekOf = u => { const m = u.match(/(\d{4})[-_](\d{1,2})[-_]?miserend/i); return m ? +m[1] * 100 + +m[2] : 0; };

// The schedule's PDF: /miserend/ links (or redirects) to it. If the link is stale, try this and next week's usual file names.
async function findPdf() {
  if (process.env.PDF_URL) return process.env.PDF_URL;
  const found = new Set();
  try {
    const res = await fetch(PAGE, { headers: UA, redirect: "follow" });
    if (/pdf/i.test(res.headers.get("content-type") || "")) return res.url;
    const html = await res.text();
    for (const m of html.matchAll(/https?:\/\/(?:www\.)?pestiferencesek\.hu\/wp-content\/uploads\/[^"'\s<>]+?\.pdf/gi)) if (/miserend/i.test(m[0])) found.add(m[0]);
  } catch (err) { console.warn(`Could not read ${PAGE}: ${err.message}`); }
  const now = new Date();
  for (const add of [0, 7]) {
    const { y, w } = isoWeek(new Date(now.getTime() + add * 864e5));
    for (const back of [0, 1]) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
      found.add(`${SITE}/wp-content/uploads/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${y}-${w}miserend.pdf`); }
  }
  // Newest week first; the first one that exists wins.
  for (const u of [...found].sort((a, b) => weekOf(b) - weekOf(a))) {
    try { const r = await fetch(u, { method: "HEAD", headers: UA }); if (r.ok && /pdf/i.test(r.headers.get("content-type") || "pdf")) return u; } catch { }
  }
  throw new Error("No schedule PDF found on pestiferencesek.hu. Nothing was written.");
}

async function findChurch() {
  if (process.env.CHURCH_ID) return { id: +process.env.CHURCH_ID, name: "(CHURCH_ID)" };
  const d = 0.002, list = await api(`churches?select=id,name,lat,lon&lat=gte.${CHURCH.lat - d}&lat=lte.${CHURCH.lat + d}&lon=gte.${CHURCH.lon - d}&lon=lte.${CHURCH.lon + d}`);
  const dist = c => Math.hypot((c.lat - CHURCH.lat) * 111, (c.lon - CHURCH.lon) * 75);
  const c = list.filter(c => CHURCH.name.test(c.name) || dist(c) < 0.03).sort((a, b) => (CHURCH.name.test(b.name) - CHURCH.name.test(a.name)) || dist(a) - dist(b))[0];
  if (!c) throw new Error("The Franciscan church at Ferenciek tere is not in the database. Nothing was written.");
  return c;
}

async function main() {
  if (!DRY && (!url || !key)) throw new Error("Set the SUPABASE_URL and SUPABASE_SECRET_KEY repository secrets first.");
  let pdfUrl = "local file", buf;
  if (process.env.SOURCE_PDF) buf = fs.readFileSync(process.env.SOURCE_PDF);
  else { pdfUrl = await findPdf(); console.log(`Downloading ${pdfUrl}`); const r = await fetch(pdfUrl, { headers: UA }); if (!r.ok) throw new Error(`HTTP ${r.status}`); buf = Buffer.from(await r.arrayBuffer()); }
  const rows = parseWeek(await pdfItems(buf));
  const days = [...new Set(rows.map(r => r.date))].sort();
  const masses = rows.filter(r => r.kind === "mass").length;
  console.log(`${days.length} days (${days[0]} – ${days[days.length - 1]}), ${masses} Masses, ${rows.filter(r => r.kind === "confession").length} confession ranges, ${rows.filter(r => r.kind === "prayer" || r.kind === "adoration").length} other.`);
  if (days.length < 3 || masses < days.length * 2) throw new Error("The PDF does not look like the usual weekly schedule; its layout may have changed. Nothing was written.");
  const lines = [`# Pesti ferencesek – heti miserend${DRY ? " (próbafuttatás)" : ""}`, "", `Forrás: ${pdfUrl}`, "",
    ...days.map(d => `- **${d}**: ${rows.filter(r => r.date === d).map(r => r.kind === "confession" ? `gyónás ${r.start}–${r.end}` : r.kind === "mass" ? r.start + (r.celebrant ? ` (${r.celebrant})` : "") : `${r.start} ${r.note || (r.kind === "adoration" ? "szentségimádás" : "")}`).join(", ")}`)];
  if (!DRY) {
    const church = await findChurch();
    const n = await api("rpc/import_dated_services", { method: "POST", body: JSON.stringify({ p: { church_id: church.id, source: SOURCE, source_url: pdfUrl, from: days[0], to: days[days.length - 1],
      rows: rows.map(r => ({ date: r.date, kind: r.kind, start: r.start, end: r.end, note: r.note, celebrant: r.celebrant || "" })) } }) });
    lines.splice(2, 0, `Templom: ${church.name} (#${church.id}), ${n} időpont mentve.`, "");
  }
  const md = lines.join("\n") + "\n";
  fs.writeFileSync("report.md", md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(md);
}
main().catch(err => { console.error("Import failed:", err.message); process.exit(1); });
