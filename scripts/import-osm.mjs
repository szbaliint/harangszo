// Imports Catholic churches in Hungary from OpenStreetMap into Supabase.
// Adds churches that are not in the database yet; never changes or deletes existing rows,
// so your own edits are safe. Runs in GitHub Actions (see .github/workflows/import-osm.yml).
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

const R = Math.PI / 180;
function km(aLat, aLon, bLat, bLon) {
  const dLa = (bLat - aLat) * R, dLo = (bLon - aLon) * R;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(aLat * R) * Math.cos(bLat * R) * Math.sin(dLo / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// Grid index of settlements so nearest-settlement lookups stay fast for thousands of churches.
export function settlementIndex(places) {
  // Prefer the "real" settlement over a suburb/quarter (Budapest districts) when assigning the city name.
  const RANK = { city: 0, town: 0, village: 0, hamlet: 1, suburb: 2, quarter: 2 };
  const grid = new Map(), key = (la, lo) => `${Math.floor(la * 10)}:${Math.floor(lo * 10)}`;
  for (const p of places) {
    if (!p.tags?.name || p.lat == null) continue;
    const item = { name: p.tags.name, lat: p.lat, lon: p.lon, rank: RANK[p.tags.place] ?? 3, isIn: p.tags["is_in:city"] || null };
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
    return best?.name || "";
  };
}

export function toChurch(el, nearestCity) {
  const t = el.tags || {};
  const name = (t.name || t["name:hu"] || "").trim();
  if (!name) return null;                          // unnamed wayside chapels and crosses are skipped
  const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;
  const street = [t["addr:street"] || t["addr:place"], t["addr:housenumber"]].filter(Boolean).join(" ");
  const city = (t["addr:city"] || "").trim() || nearestCity(lat, lon);
  return {
    osm_type: el.type, osm_id: el.id, name: name.slice(0, 200), city, address: street,
    rite: t.denomination === "greek_catholic" ? "gk" : "rk",
    lat: +lat.toFixed(6), lon: +lon.toFixed(6),
    website: t.website || t["contact:website"] || null,
    phone: t.phone || t["contact:phone"] || null,
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
  const gk = rows.filter(r => r.rite === "gk").length, noCity = rows.filter(r => !r.city).length;
  console.log(`Prepared ${rows.length} named churches (${gk} görögkatolikus, ${noCity} without a settlement name).`);
  if (dry) { console.log("DRY_RUN=1, nothing written. Sample:", rows.slice(0, 3)); return; }

  const before = await countChurches({ url, key });
  await insertNew(rows, { url, key });
  const after = await countChurches({ url, key });
  console.log(`Done. Churches in database: ${before} → ${after} (${after - before} new; existing rows untouched).`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error("Import failed:", e.message); process.exit(1); });
