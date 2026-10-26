// Imports Catholic churches in Hungary from OpenStreetMap into Supabase.
// Adds churches that are not in the database yet and refreshes their importance score. Never changes names,
// times or anything editors set, and never deletes rows. Runs in GitHub Actions (see .github/workflows/import-osm.yml).
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEY (sb_secret_… or a legacy service_role key)   Optional: DRY_RUN=1 (only count, write nothing)
// Data © OpenStreetMap contributors, ODbL. The site credits this in the map attribution.

const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

const CHURCH_QUERY = `[out:json][timeout:300];
area["ISO3166-1"="HU"][admin_level=2]->.hu;
nwr["amenity"="place_of_worship"]["religion"="christian"]["denomination"~"^(roman_catholic|catholic|greek_catholic)$"](area.hu);
out center tags;`;

const PLACE_QUERY = `[out:json][timeout:300];
area["ISO3166-1"="HU"][admin_level=2]->.hu;
node["place"~"^(city|town|village|hamlet)$"]["name"](area.hu);
out;`;

export async function overpass(query, fetchImpl = fetch) {
  let lastErr;
  for (const url of OVERPASS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "harangszo-import (github.com/szbaliint/harangszo)" },
          body: "data=" + encodeURIComponent(query),
        });
        if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
        return (await res.json()).elements;
      } catch (e) { lastErr = e; console.warn("Overpass attempt failed:", e.message); await new Promise(r => setTimeout(r, 5000 * attempt)); }
    }
  }
  throw lastErr;
}

const fold = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const R = Math.PI / 180;
function km(aLat, aLon, bLat, bLon) {
  const dLa = (bLat - aLat) * R, dLo = (bLon - aLon) * R;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(aLat * R) * Math.cos(bLat * R) * Math.sin(dLo / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// Importance 0–100: how notable a church is, so the map can show the important ones first.
// Signals: cathedral / basilica / pilgrimage church in the name or tags, a Wikipedia or Wikidata entry,
// heritage listing, the size of the settlement; chapels rank lower.
export function importanceOf(t, settlement) {
  const name = (t.name || "").toLowerCase();
  let s = 30;
  if (/főszékesegyház|székesegyház|katedrális/.test(name) || t.building === "cathedral") s += 40;
  else if (/bazilika/.test(name) || /basilica/i.test(t["basilica"] || "") || t.building === "basilica") s += 30;
  if (/kegytemplom|kegyhely|zarándok|búcsújáró|kegyhely/.test(name) || t.pilgrimage === "yes") s += 20;
  if (t.wikidata || t.wikipedia || t["wikipedia:hu"]) s += 20;
  if (t.heritage || t["heritage:operator"] || t["ref:hu:mjsz"]) s += 8;
  if (t.building === "chapel" || t.amenity_type === "chapel" || /kápolna|kálvária/.test(name)) s -= 18;
  const place = settlement?.place, pop = settlement?.pop || 0;
  if (place === "city") s += 12 + (pop > 100000 ? 6 : 0); else if (place === "town") s += 6; else if (place === "hamlet") s -= 6;
  return Math.max(0, Math.min(100, Math.round(s)));
}

// Grid index of settlements so nearest-settlement lookups stay fast for thousands of churches.
export function settlementIndex(places) {
  // Prefer the "real" settlement over a suburb/quarter (Budapest districts) when assigning the city name.
  const RANK = { city: 0, town: 0, village: 0, hamlet: 1, suburb: 2, quarter: 2 };
  const grid = new Map(), key = (la, lo) => `${Math.floor(la * 10)}:${Math.floor(lo * 10)}`;
  for (const p of places) {
    if (!p.tags?.name || p.lat == null) continue;
    const item = { name: p.tags.name, place: p.tags.place, pop: Number(p.tags.population) || 0, lat: p.lat, lon: p.lon, rank: RANK[p.tags.place] ?? 3 };
    const k = key(item.lat, item.lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(item);
  }
  return (lat, lon) => {
    let best = null, bestScore = Infinity;
    const cy = Math.floor(lat * 10), cx = Math.floor(lon * 10);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const s of grid.get(`${cy + dy}:${cx + dx}`) || []) {
        if (s.rank >= 2) continue;               // suburbs are only used via is_in below
        const d = km(lat, lon, s.lat, s.lon);
        const score = d + s.rank * 2;            // a hamlet must be 2 km closer to beat a village
        if (d < 12 && score < bestScore) { best = s; bestScore = score; }
      }
    }
    return best ? { name: best.name, place: best.place, pop: best.pop } : { name: "", place: "", pop: 0 };
  };
}

export function toChurch(el, nearestCity) {
  const t = el.tags || {};
  const name = (t.name || t["name:hu"] || "").trim();
  if (!name) return null;                          // unnamed wayside chapels and crosses are skipped
  const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;
  const street = [t["addr:street"] || t["addr:place"], t["addr:housenumber"]].filter(Boolean).join(" ");
  const near = nearestCity(lat, lon);
  const city = (t["addr:city"] || "").trim() || near.name;
  return {
    osm_type: el.type, osm_id: el.id, name: name.slice(0, 200), city, address: street,
    rite: t.denomination === "greek_catholic" ? "gk" : "rk",
    lat: +lat.toFixed(6), lon: +lon.toFixed(6),
    website: t.website || t["contact:website"] || null,
    phone: t.phone || t["contact:phone"] || null,
    importance_auto: importanceOf(t, near),
  };
}

const authHeaders = key => ({ apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}) });

async function insertNew(rows, { url, key }) {
  let sent = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const res = await fetch(`${url}/rest/v1/churches?on_conflict=osm_type,osm_id`, {
      method: "POST",
      headers: { ...authHeaders(key), "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`Supabase insert failed (HTTP ${res.status}): ${await res.text()}`);
    sent += batch.length;
    console.log(`  sent ${sent}/${rows.length}`);
  }
}

async function refreshImportance(rows, { url, key }) {
  let changed = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const batch = rows.slice(i, i + 1000).map(r => ({ t: r.osm_type, id: r.osm_id, imp: r.importance_auto }));
    const res = await fetch(`${url}/rest/v1/rpc/set_church_importance`, { method: "POST", headers: { ...authHeaders(key), "Content-Type": "application/json" }, body: JSON.stringify({ rows: batch }) });
    if (!res.ok) throw new Error(`Importance update failed (HTTP ${res.status}): ${await res.text()}. Did you run supabase/migrations/003_importance.sql?`);
    changed += await res.json();
  }
  return changed;
}

async function countChurches({ url, key }) {
  const res = await fetch(`${url}/rest/v1/churches?select=id`, { method: "HEAD", headers: { ...authHeaders(key), Prefer: "count=exact" } });
  return Number((res.headers.get("content-range") || "").split("/")[1]) || 0;
}

async function main() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/$/, ""), key = process.env.SUPABASE_SECRET_KEY;
  const dry = process.env.DRY_RUN === "1";
  if (!dry && (!url || !key)) throw new Error("Set the SUPABASE_URL and SUPABASE_SECRET_KEY repository secrets first.");

  console.log("Downloading Catholic churches from OpenStreetMap…");
  const els = await overpass(CHURCH_QUERY);
  console.log(`  ${els.length} elements`);
  console.log("Downloading settlement names…");
  const nearest = settlementIndex(await overpass(PLACE_QUERY));

  const seen = new Set(), rows = [];
  for (const el of els) {
    const c = toChurch(el, nearest);
    if (!c) continue;
    const k = c.osm_type + c.osm_id; if (seen.has(k)) continue; seen.add(k);
    rows.push(c);
  }
  // One church is sometimes mapped twice (a point and the building outline). Keep the outline.
  const order = { relation: 0, way: 1, node: 2 };
  rows.sort((a, b) => order[a.osm_type] - order[b.osm_type]);
  const words = n => fold(n).split(/[^a-z0-9]+/).filter(t => t.length > 3 && !/^(szent|templom|kapolna|plebania|katolikus|romai)$/.test(t));
  const kept = [];
  for (const r of rows) {
    const twin = kept.find(k => Math.abs(k.lat - r.lat) < 0.0006 && Math.abs(k.lon - r.lon) < 0.0009 &&
      (words(k.name).some(a => words(r.name).some(b => a.slice(0, 5) === b.slice(0, 5))) || !words(k.name).length || !words(r.name).length));
    if (!twin) kept.push(r);
  }
  if (kept.length < rows.length) console.log(`Skipped ${rows.length - kept.length} duplicate map objects (same church mapped twice).`);
  rows.length = 0; rows.push(...kept);
  const gk = rows.filter(r => r.rite === "gk").length, noCity = rows.filter(r => !r.city).length;
  console.log(`Prepared ${rows.length} named churches (${gk} görögkatolikus, ${noCity} without a settlement name).`);
  const top = [...rows].sort((a, b) => b.importance_auto - a.importance_auto).slice(0, 15).map(r => `${r.importance_auto}  ${r.name} (${r.city})`);
  console.log("Most important by score:\n  " + top.join("\n  "));
  if (dry) { console.log("DRY_RUN=1, nothing written."); return; }

  const before = await countChurches({ url, key });
  await insertNew(rows, { url, key });
  const after = await countChurches({ url, key });
  console.log("Updating importance scores of existing OpenStreetMap churches…");
  const changed = await refreshImportance(rows, { url, key });
  console.log(`Done. Churches in database: ${before} → ${after} (${after - before} new). Importance updated for ${changed}; names, times and your edits untouched.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error("Import failed:", e.message); process.exit(1); });
