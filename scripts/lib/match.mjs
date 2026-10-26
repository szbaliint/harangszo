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

// Pick the database church for an entry. Returns { church, how, sim, dist } or null.
export function matchChurch(entry, anchor, churches, claimed) {
  if (!anchor) return null;
  const radius = anchor.level === "district" ? 2.5 : (anchor.place === "city" || anchor.place === "town") ? 6 : 3;
  const cands = churches
    .filter(c => !claimed.has(c.id) && !(c.schedule_source && c.source_ref && c.schedule_source !== "szfvar"))
    .map(c => ({ c, dist: km(anchor.lat, anchor.lon, c.lat, c.lon), sim: entry.name ? nameSim(entry.name, c.name) : 0 }))
    .filter(x => x.dist <= radius)
    .sort((a, b) => b.sim - a.sim || a.dist - b.dist);
  if (!cands.length) return null;
  const top = cands[0];
  if (entry.name && top.sim >= 0.5) return { church: top.c, how: "name", sim: top.sim, dist: top.dist };
  // A single church nearby with a generic name ("Római katolikus templom") is safe for a parish in a village.
  const near = cands.filter(x => x.dist <= 1.5);
  if (near.length === 1 && tokens(near[0].c.name).length === 0 && entry.type !== "place") return { church: near[0].c, how: "only-church", sim: 0, dist: near[0].dist };
  if (!entry.name && near.length === 1 && entry.type === "parish") return { church: near[0].c, how: "only-church", sim: 0, dist: near[0].dist };
  return null;
}
