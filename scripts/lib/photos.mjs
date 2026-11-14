// Pure helpers of the photo import (scripts/import-photos.mjs): which Commons file a church's OpenStreetMap tags or
// Wikidata item name, which licences are free enough to show, and how the credit line reads. No network here.

export const USER_AGENT = "Harangszo-photo-import/1.0 (+https://github.com/szbaliint/harangszo)";

/** Splits a list into consecutive batches of at most n items. */
export function chunk(list, n) {
  if (!(n >= 1)) throw new Error("batch size must be at least 1");
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** Overpass query for the tags of the given OSM objects ([{osm_type, osm_id}], at most a couple of hundred). */
export function overpassQuery(items) {
  const by = { node: [], way: [], relation: [] };
  for (const it of items) if (by[it.osm_type] && Number.isSafeInteger(+it.osm_id)) by[it.osm_type].push(+it.osm_id);
  const parts = Object.entries(by).filter(([, ids]) => ids.length).map(([t, ids]) => `${t}(id:${ids.join(",")});`);
  return `[out:json][timeout:120];(${parts.join("")});out tags;`;
}

/** "File:Foo bar.jpg" from a Commons file name, page URL or upload URL; null if it isn't a Commons file. */
export function commonsTitle(value) {
  let s = String(value || "").trim();
  if (!s) return null;
  try { s = decodeURIComponent(s); } catch { }
  let name = null, m;
  if ((m = s.match(/^https?:\/\/(?:commons\.(?:m\.)?wikimedia\.org\/wiki\/|[a-z-]+\.(?:m\.)?wikipedia\.org\/wiki\/)(?:File|Fájl|Image|Kép):(.+?)(?:[?#].*)?$/i))) name = m[1];
  else if ((m = s.match(/^https?:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/thumb\/[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+)\//i))) name = m[1];
  else if ((m = s.match(/^https?:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+)$/i))) name = m[1];
  else if ((m = s.match(/^(?:File|Image|Fájl|Kép):(.+)$/i))) name = m[1];
  else if (!/^[a-z]+:/i.test(s) && /\.(jpe?g|png|webp|tiff?)$/i.test(s)) name = s;   // a bare file name (Wikidata P18)
  if (!name) return null;
  name = name.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  if (!name || /[#<>[\]|{}]/.test(name)) return null;
  return "File:" + name.charAt(0).toUpperCase() + name.slice(1);
}

/** Commons file named by an OSM object's tags: wikimedia_commons (File:…) first, then image. Categories are skipped. */
export function osmFile(tags = {}) {
  for (const v of String(tags.wikimedia_commons || "").split(";")) { const t = /^\s*(File|Image):/i.test(v) ? commonsTitle(v) : null; if (t) return t; }
  for (const v of String(tags.image || "").split(";")) { const t = commonsTitle(v); if (t) return t; }
  return null;
}

/** The Wikidata item of an OSM object ("Q123"), or null. */
export function osmWikidata(tags = {}) {
  const q = String(tags.wikidata || "").split(";")[0].trim().toUpperCase();
  return /^Q[1-9]\d*$/.test(q) ? q : null;
}

/** The P18 (image) file of a Wikidata entity from wbgetentities: preferred rank first, never deprecated. */
export function wikidataImage(entity) {
  const claims = (entity?.claims?.P18 || []).filter(c => c.rank !== "deprecated" && c.mainsnak?.snaktype === "value");
  const best = claims.find(c => c.rank === "preferred") || claims[0];
  return best ? commonsTitle(String(best.mainsnak.datavalue?.value || "")) : null;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—" };
/** Plain text from Commons' HTML metadata: no tags, entities decoded, whitespace collapsed. */
export function stripHtml(html) {
  return String(html || "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ").trim();
}

/**
 * Is this licence free to show with a credit line? CC0, public domain, CC BY and CC BY-SA (any version or port).
 * Not NC/ND, not GFDL-only, not "fair use". `license` is Commons' machine-readable License field (cc-by-sa-4.0),
 * `shortName` its LicenseShortName (CC BY-SA 4.0); either may be missing.
 */
export function isFreeLicense(shortName, license) {
  for (const raw of [license, shortName]) {
    const s = String(raw || "").toLowerCase().replace(/[_\s]+/g, " ").trim();
    if (!s) continue;
    if (/\b(nc|nd)\b|non-?commercial|no ?deriv|fair use|non-free/.test(s)) return false;
    if (/^(cc0|cc-zero|cc zero)\b/.test(s)) return true;
    if (/^(pd\b|pd-|public domain)/.test(s)) return true;
    if (/^cc[ -]?by(?:[ -]sa)?(?:[ -]?\d(?:\.\d)?|$)/.test(s)) return true;
  }
  return false;
}

/** Short licence name for the credit line: "CC BY-SA 4.0", "CC0", "Public domain". */
export function licenceLabel(shortName, license) {
  const s = stripHtml(shortName);
  if (s) return s.slice(0, 40);
  const l = String(license || "").toLowerCase();
  if (/^cc0/.test(l)) return "CC0";
  if (/^pd/.test(l)) return "Public domain";
  const m = l.match(/^cc-(by(?:-sa)?)-(\d(?:\.\d)?)/);
  return m ? `CC ${m[1].toUpperCase()} ${m[2]}` : "";
}

/** "Fotó: <author> · <licence> · Wikimedia Commons" (the author part is left out when Commons has none). */
export function formatCredit(author, licence) {
  let a = stripHtml(author);
  if (a.length > 120) a = a.slice(0, 119).replace(/\s+\S*$/, "") + "…";
  const parts = [a, stripHtml(licence), "Wikimedia Commons"].filter(Boolean);
  return "Fotó: " + parts.join(" · ");
}

/** An https URL on Wikimedia's media hosts, without the utm_* tracking parameters Commons now appends; else null. */
export function wikimediaUrl(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch { return null; }
  if (u.protocol !== "https:" || !/^(upload|thumb)\.wikimedia\.org$/.test(u.hostname)) return null;
  for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
  return u.toString();
}

const IMAGE_MIME =/^image\/(jpeg|png|webp|tiff)$/;
/**
 * One Commons imageinfo page (formatversion=2) → {url, credit, page} for a free photo, or {rejected: reason}.
 * url is the about 1000 px wide thumbnail (or the original when it is smaller).
 */
export function photoFromImageInfo(page) {
  if (!page || page.missing || page.invalid) return { rejected: "missing" };
  const ii = page.imageinfo?.[0];
  if (!ii) return { rejected: "missing" };
  if (ii.mime && !IMAGE_MIME.test(ii.mime)) return { rejected: "not a photo" };
  const md = ii.extmetadata || {};
  const shortName = md.LicenseShortName?.value, license = md.License?.value;
  if (!isFreeLicense(stripHtml(shortName), license)) return { rejected: "licence" };
  const url = wikimediaUrl(ii.thumburl) || wikimediaUrl(ii.url);
  if (!url) return { rejected: "missing" };
  const author = stripHtml(md.Artist?.value) || "";
  return { url, credit: formatCredit(author, licenceLabel(shortName, license)), page: ii.descriptionurl || null };
}

/**
 * Maps the titles asked for to the pages of a Commons query response, following `normalized` and `redirects`.
 * Returns Map<asked title, page>.
 */
export function pagesByTitle(asked, query) {
  const byTitle = new Map((query?.pages || []).map(p => [p.title, p]));
  const step = list => new Map((list || []).map(x => [x.from, x.to]));
  const norm = step(query?.normalized), redir = step(query?.redirects);
  const out = new Map();
  for (const t of asked) {
    let k = norm.get(t) || t;
    k = redir.get(k) || k;
    if (byTitle.has(k)) out.set(t, byTitle.get(k));
  }
  return out;
}

/** Most important first (importance_manual over importance_auto), then by id for a stable order. */
export function byImportance(a, b) {
  const ia = a.importance_manual ?? a.importance_auto ?? 0, ib = b.importance_manual ?? b.importance_auto ?? 0;
  return ib - ia || a.id - b.id;
}
