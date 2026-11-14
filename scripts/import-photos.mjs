// Puts a free Wikimedia Commons photo on churches imported from OpenStreetMap.
// For each church with an OSM object (most important first) it reads the object's wikimedia_commons / image /
// wikidata tags from Overpass, asks Wikidata for the item's image (P18) when OSM names no file itself, then asks
// Commons for the author, the licence and a 1000 px thumbnail. Only CC0, public domain, CC BY and CC BY-SA files
// are used; the credit line reads "Fotó: <author> · <licence> · Wikimedia Commons".
// A parish's own photo is never replaced (import_church_photos() checks this in the database too). A Commons photo
// whose file vanished or changed to a non-free licence is removed; a failed request changes nothing.
// Runs in GitHub Actions by hand (.github/workflows/import-photos.yml). Needs migration 013.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEY   Optional: DRY_RUN=1 (look everything up, write nothing), LIMIT=<n> (first n
// churches by importance), OVERPASS_URL (another Overpass instance)
import {
  USER_AGENT, chunk, overpassQuery, osmFile, osmWikidata, wikidataImage, photoFromImageInfo, pagesByTitle, byImportance,
} from "./lib/photos.mjs";

const OVERPASS = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
const WIKIDATA = "https://www.wikidata.org/w/api.php";
const COMMONS = "https://commons.wikimedia.org/w/api.php";
const OSM_BATCH = 200, WIKI_BATCH = 50, OVERPASS_PAUSE_MS = 5000, WIKIMEDIA_GAP_MS = 1000;

const url = (process.env.SUPABASE_URL || "").replace(/\/$/, ""), key = process.env.SUPABASE_SECRET_KEY || "";
const DRY = process.env.DRY_RUN === "1", LIMIT = Number(process.env.LIMIT) || 0;
const H = () => ({ apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(path, opts = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, { ...opts, headers: { ...H(), ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path.split("?")[0]} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

// One polite HTTP call: our User-Agent, retries with backoff on 429/5xx and network errors (Retry-After respected).
// Wikimedia calls are spaced at least a second apart. (No maxlag: these are reads, and Wikidata's maxlag also counts
// the query service's lag, which often refuses every request for minutes.)
let lastWikimedia = 0;
async function politeFetch(target, init = {}, { wikimedia = false, tries = 5 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (wikimedia) { const wait = lastWikimedia + WIKIMEDIA_GAP_MS - Date.now(); if (wait > 0) await sleep(wait); lastWikimedia = Date.now(); }
    let res;
    try {
      res = await fetch(target, { ...init, headers: { "User-Agent": USER_AGENT, "Api-User-Agent": USER_AGENT, Accept: "application/json", ...(init.headers || {}) } });
    } catch (e) { lastErr = e; }
    if (res?.ok) {
      const body = await res.json();
      if (body?.error) throw new Error(`${new URL(target).host}: ${body.error.code} ${String(body.error.info || "").slice(0, 200)}`);
      return body;
    } else if (res) {
      lastErr = new Error(`${new URL(target).host} → HTTP ${res.status}`);
      if (![429, 500, 502, 503, 504].includes(res.status)) throw lastErr;
    }
    if (attempt < tries) {
      const ra = Number(res?.headers?.get("retry-after"));
      const ms = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 300) * 1000 : 5000 * 2 ** (attempt - 1);
      console.warn(`  ${lastErr.message}; waiting ${Math.round(ms / 1000)} s (attempt ${attempt}/${tries})`);
      await sleep(ms);
    }
  }
  throw lastErr;
}

async function loadChurches() {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const page = await api(`churches?select=id,name,city,osm_type,osm_id,importance_auto,importance_manual,photo_source,photo_url` +
      `&osm_id=not.is.null&or=(photo_source.is.null,photo_source.eq.commons)&order=id&limit=1000&offset=${from}`);
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out.sort(byImportance);
}

// OSM tags of every church, 200 objects per Overpass query. Churches of a failed batch are left out (not checked).
async function osmTags(churches, stats) {
  const tags = new Map();   // "way/123" → tags (an object missing from OSM gets {})
  const batches = chunk(churches, OSM_BATCH);
  for (const [i, batch] of batches.entries()) {
    if (i) await sleep(OVERPASS_PAUSE_MS);
    try {
      const body = await politeFetch(OVERPASS, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(overpassQuery(batch)) });
      for (const c of batch) tags.set(`${c.osm_type}/${c.osm_id}`, {});
      for (const el of body.elements || []) tags.set(`${el.type}/${el.id}`, el.tags || {});
    } catch (e) { stats.failed += batch.length; console.warn(`  Overpass batch ${i + 1}/${batches.length} failed, skipped: ${e.message}`); }
    console.log(`  OpenStreetMap ${Math.min((i + 1) * OSM_BATCH, churches.length)}/${churches.length}`);
  }
  return tags;
}

// Wikidata P18 for items, 50 per request. Returns Map<Q, "File:…" | null>; items of a failed batch are absent.
async function wikidataImages(qids) {
  const out = new Map();
  for (const batch of chunk(qids, WIKI_BATCH)) {
    try {
      const body = await politeFetch(`${WIKIDATA}?action=wbgetentities&format=json&formatversion=2&props=claims&ids=${batch.map(encodeURIComponent).join("|")}`, {}, { wikimedia: true });
      const ents = Object.values(body.entities || {});
      for (const q of batch) {
        const e = body.entities?.[q] || ents.find(x => x.redirects?.from === q);
        out.set(q, e && !("missing" in e) ? wikidataImage(e) : null);
      }
    } catch (e) { console.warn(`  Wikidata batch failed, skipped: ${e.message}`); }
  }
  return out;
}

// Commons imageinfo for files, 50 per request. Returns Map<title, {url, credit, page} | {rejected}>; failed batches absent.
async function commonsPhotos(titles) {
  const out = new Map();
  for (const batch of chunk(titles, WIKI_BATCH)) {
    try {
      const params = new URLSearchParams({ action: "query", format: "json", formatversion: "2", redirects: "1",
        prop: "imageinfo", iiprop: "extmetadata|url|mime", iiurlwidth: "1000", iiextmetadatafilter: "Artist|LicenseShortName|License",
        titles: batch.join("|") });
      const body = await politeFetch(COMMONS, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() }, { wikimedia: true });
      const pages = pagesByTitle(batch, body.query);
      for (const t of batch) out.set(t, photoFromImageInfo(pages.get(t)));
    } catch (e) { console.warn(`  Commons batch failed, skipped: ${e.message}`); }
  }
  return out;
}

async function main() {
  if (!url || !key) throw new Error("Set the SUPABASE_URL and SUPABASE_SECRET_KEY repository secrets first (a dry run reads the church list too).");
  const stats = { failed: 0 };

  console.log("Loading churches with an OpenStreetMap object (no parish photo)…");
  let churches = await loadChurches();
  if (LIMIT) churches = churches.slice(0, LIMIT);
  console.log(`  ${churches.length} churches${LIMIT ? ` (LIMIT=${LIMIT})` : ""}, ${churches.filter(c => c.photo_source === "commons").length} already with a Commons photo`);

  console.log("Reading their tags from OpenStreetMap (Overpass)…");
  const tags = await osmTags(churches, stats);

  // Per church: the file OSM names, else the Wikidata item to ask.
  const plan = new Map();   // church id → { file?, qid? }
  for (const c of churches) {
    const t = tags.get(`${c.osm_type}/${c.osm_id}`);
    if (!t) continue;                                   // its batch failed: leave the church as it is
    plan.set(c.id, { file: osmFile(t), qid: osmWikidata(t) });
  }
  const viaOsm = [...plan.values()].filter(p => p.file).length;
  const qids = [...new Set([...plan.values()].filter(p => !p.file && p.qid).map(p => p.qid))];
  console.log(`  ${viaOsm} name a Commons file in OSM, ${qids.length} more have only a Wikidata item`);

  console.log("Asking Wikidata for the items' images (P18)…");
  const p18 = await wikidataImages(qids);
  let viaWikidata = 0, wikidataFailed = 0;
  for (const p of plan.values()) {
    if (p.file || !p.qid) continue;
    if (!p18.has(p.qid)) { p.skip = true; wikidataFailed++; continue; }
    p.file = p18.get(p.qid); if (p.file) viaWikidata++;
  }
  console.log(`  ${viaWikidata} images found on Wikidata`);

  const titles = [...new Set([...plan.values()].map(p => p.file).filter(Boolean))];
  console.log(`Checking ${titles.length} files on Wikimedia Commons (licence, author, thumbnail)…`);
  const photos = await commonsPhotos(titles);

  const rows = [], rejected = {}, samples = [];
  let found = 0, none = 0, skipped = stats.failed + wikidataFailed;
  for (const c of churches) {
    const p = plan.get(c.id);
    if (!p || p.skip) continue;
    if (p.file && !photos.has(p.file)) { skipped++; continue; }            // its Commons batch failed
    const ph = p.file ? photos.get(p.file) : null;
    if (ph?.url) {
      found++; rows.push({ id: c.id, url: ph.url, credit: ph.credit, page: ph.page });
      if (samples.length < 12) samples.push(`${c.name} (${c.city}): ${ph.credit}`);
    } else {
      none++; rows.push({ id: c.id, url: null });
      if (ph?.rejected) rejected[ph.rejected] = (rejected[ph.rejected] || 0) + 1;
    }
  }
  const cleared = new Set(rows.filter(r => !r.url).map(r => r.id));
  const removed = churches.filter(c => c.photo_source === "commons" && cleared.has(c.id)).length;
  console.log(`Free photo for ${found} churches, none for ${none} (files rejected: ${JSON.stringify(rejected)}), ${skipped} not checked because a request failed.`);
  if (removed) console.log(`  ${removed} churches lose their earlier Commons photo (file gone or no longer free).`);
  if (samples.length) console.log("Examples:\n  " + samples.join("\n  "));
  if (DRY) { console.log("DRY_RUN=1, nothing written."); return; }

  let changed = 0;
  for (const batch of chunk(rows, 500)) {
    const res = await fetch(`${url}/rest/v1/rpc/import_church_photos`, { method: "POST", headers: H(), body: JSON.stringify({ rows: batch }) });
    if (!res.ok) throw new Error(`Photo update failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}. Did you run supabase/migrations/013_photos.sql?`);
    changed += await res.json();
  }
  console.log(`Done. ${changed} churches got a new or changed photo; ${rows.length} checked. Parish photos untouched.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error("Photo import failed:", e.message); process.exit(1); });
