// Matching imported schedule entries to churches already in the database (mostly from OpenStreetMap).
import { fold } from "./szfvar.mjs";

const STOP = new Set(["szent", "szt", "templom", "templomot", "plebania", "plebaniatemplom", "kapolna", "kapolnaja", "rk", "romai", "katolikus",
  "filia", "filiatemplom", "misezohely", "a", "az", "es", "egyhaz", "templomigazgatosag", "rom", "kat"]);
export const tokens = s => fold(s).split(/[^a-z0-9]+/).filter(t => t.length > 1 && !STOP.has(t));
const same = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));
// Share of the source name's words found in the church name (0..1).
export function nameSim(sourceName, churchName) {
  const a = tokens(sourceName), b = tokens(churchName);
  if (!a.length) return 0;
  return a.filter(t => b.some(u => same(t, u))).length / a.length;
}
export function km(aLat, aLon, bLat, bLon) {
  const R = Math.PI / 180, dLa = (bLat - aLat) * R, dLo = (bLon - aLon) * R;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(aLat * R) * Math.cos(bLat * R) * Math.sin(dLo / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// Index of OpenStreetMap place nodes by folded name. Several places can share a name; resolve() picks the
// one nearest to a reference point (the diocese, or the settlement for a district).
export function placeIndex(elements) {
  const idx = new Map();
  for (const p of elements) {
    if (!p.tags?.name || p.lat == null) continue;
    for (const n of new Set([p.tags.name, p.tags["name:hu"], p.tags.alt_name].filter(Boolean))) {
      const k = fold(n); if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push({ name: p.tags.name, lat: p.lat, lon: p.lon, place: p.tags.place });
    }
  }
  const RANK = { city: 0, town: 0, village: 1, suburb: 2, quarter: 2, neighbourhood: 3, hamlet: 3, isolated_dwelling: 4, locality: 5 };
  return {
    resolve(name, near, maxKm = 80) {
      const list = idx.get(fold(name)); if (!list) return null;
      let best = null, bestScore = Infinity;
      for (const p of list) {
        const d = near ? km(near.lat, near.lon, p.lat, p.lon) : 0;
        if (d > maxKm) continue;
        const score = d + (RANK[p.place] ?? 5) * 3;
        if (score < bestScore) { best = p; bestScore = score; }
      }
      return best;
    }
  };
}

export const DIOCESE_CENTRE = { lat: 47.25, lon: 18.6 };

// Where should this entry be? District point if found near the settlement, else the settlement, else the
// settlement in the linked parish page's address.
export function anchorFor(entry, places) {
  const s = places.resolve(entry.settlement, DIOCESE_CENTRE, 90);
  if (s && entry.district) { const d = places.resolve(entry.district, s, 12) || places.resolve(`${entry.settlement}-${entry.district}`, s, 12); if (d) return { ...d, level: "district" }; }
  if (s) return { ...s, level: "settlement" };
  if (entry.slugPlace) {
    const words = entry.slugPlace.split(" ");
    for (let n = words.length; n >= 1; n--) { const p = places.resolve(words.slice(0, n).join(" "), DIOCESE_CENTRE, 90); if (p) return { ...p, level: "parish-settlement" }; }
  }
  return null;
}

// Score one database church for an entry. Name words count most; the district, the parish page's address
// ("…-vasutvidek-prohaszka") and table labels are hints that catch names like "Jó Pásztor" ↔ "Prohászka-templom".
const NOT_A_PARISH_CHURCH = /kapolna|iskola|gimnazium|otthon|korhaz|temeto|kollegium|zarda/;
export function scoreCandidate(entry, c, dist) {
  const place = new Set(tokens(entry.settlement));
  const nameT = tokens(entry.name).filter(t => !place.has(t));
  const hintT = [...new Set(tokens((entry.hints || []).join(" ")))].filter(t => !place.has(t) && !nameT.some(n => same(n, t)));
  const cT = tokens([c.name, ...(c.altNames || [])].join(" "));
  const hit = list => list.filter(t => cT.some(u => same(t, u))).length;
  const simName = nameT.length ? hit(nameT) / nameT.length : 0;
  const simHint = hintT.length ? hit(hintT) / hintT.length : 0;
  const cf = fold(c.name);
  let type = 0;
  // A parish (or rectorate) is almost never a chapel, school or hospital chapel.
  if (entry.type === "parish" || entry.type === "directorate") type = NOT_A_PARISH_CHURCH.test(cf) ? -1.2 : /templom|szekesegyhaz|bazilika|plebania/.test(cf) ? 0.15 : 0;
  const ok = simName >= 0.5 || (simHint >= 0.5 && hit(hintT) > 0);
  return { ok, score: 2 * simName + 1.2 * simHint + type - dist * 0.08, simName, simHint };
}

// All acceptable (entry, church) pairs near the entry's place, best first.
export function candidatePairs(entry, anchor, churches) {
  if (!anchor) return [];
  const radius = anchor.level === "district" ? 2.5 : (anchor.place === "city" || anchor.place === "town") ? 6 : 3;
  const out = [];
  for (const c of churches) {
    const dist = km(anchor.lat, anchor.lon, c.lat, c.lon);
    if (dist > radius) continue;
    const s = scoreCandidate(entry, c, dist);
    if (s.ok) out.push({ church: c, how: s.simName >= 0.5 ? "name" : "hint", ...s, dist });
  }
  // A village with a single church that has a generic name ("Római katolikus templom").
  if (!out.length) {
    const near = churches.map(c => ({ c, dist: km(anchor.lat, anchor.lon, c.lat, c.lon) })).filter(x => x.dist <= 1.5);
    if (near.length === 1 && entry.type !== "place" && (tokens(near[0].c.name).length === 0 || (!entry.name && entry.type === "parish")))
      out.push({ church: near[0].c, how: "only-church", score: 0.1, dist: near[0].dist });
  }
  return out.sort((a, b) => b.score - a.score);
}

// Two OpenStreetMap objects for one building (a node and the outline): very close and sharing a name word.
export function looksLikeSameBuilding(a, b) {
  if (km(a.lat, a.lon, b.lat, b.lon) > 0.06) return false;
  const ta = tokens(a.name), tb = tokens(b.name);
  return !ta.length || !tb.length || ta.some(t => tb.some(u => same(t, u)));
}
