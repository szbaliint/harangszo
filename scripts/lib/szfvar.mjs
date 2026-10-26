// Parser for the Mass schedule of the Diocese of Székesfehérvár
// (https://www.szfvar.katolikus.hu/adattar/miserend). The page is hand-edited HTML: one <h2> per church,
// a weekly table (day | free text with times in bold), optional notes, extra tables for Advent or
// other chapels, and a "Frissítve" (updated) date. Everything here is pure functions so it can be tested.
import { parseHTML } from "linkedom";

export const SOURCE = "szfvar";
export const SOURCE_NAME = "Székesfehérvári Egyházmegye";
export const SOURCE_URL = "https://www.szfvar.katolikus.hu/adattar/miserend";

export const fold = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const DAYS = { "hetfo": 1, "kedd": 2, "szerda": 3, "csutortok": 4, "pentek": 5, "szombat": 6, "vasarnap": 0 };
const MONTHS = "január|február|március|április|május|június|július|augusztus|szeptember|október|november|december";
// Feast words that can appear in a day label or in a cell, mapped to the keys used in calendar.js.
const FEAST_WORDS = [
  [/pünkösdhétf|pünkösd\s*hétf/i, "pentecost_mon"], [/pünkösd\s*vasárnap|pünkösdvasárnap|pünkösdkor|^pünkösd$/i, "pentecost"],
  [/húsvéthétf|húsvét\s*hétf/i, "easter_mon"], [/húsvét\s*vasárnap|húsvétvasárnap/i, "easter"],
  [/nagycsütörtök/i, "holy_thu"], [/nagypéntek/i, "good_fri"], [/nagyszombat/i, "holy_sat"], [/virágvasárnap/i, "palm_sun"],
  [/úrnap/i, "corpus"], [/vízkereszt/i, "jan6"], [/mindenszentek/i, "nov1"], [/halottak napj/i, "nov2"],
  [/szenteste|éjféli mise/i, "dec24"], [/karácsony másnap/i, "dec26"], [/karácsony/i, "dec25"], [/hamvazószerd/i, "ash_wed"],
];
const feastIn = s => { for (const [re, k] of FEAST_WORDS) if (re.test(s)) return k; return null; };

/* ---------- HTML → entries (mirrors what a browser's innerText would give) ---------- */
const BLOCK = new Set(["P", "DIV", "TR", "TD", "TH", "LI", "UL", "OL", "TABLE", "TBODY", "H1", "H2", "H3", "H4", "BR", "HR"]);
export function textOf(node) {
  let out = "";
  const rec = n => {
    if (n.nodeType === 3) { out += n.textContent; return; }
    if (n.nodeType !== 1 || n.tagName === "SCRIPT" || n.tagName === "STYLE") return;
    if (n.tagName === "BR") { out += "\n"; return; }
    const block = BLOCK.has(n.tagName);
    if (block) out += "\n";
    for (const c of n.childNodes) rec(c);
    if (block) out += "\n";
  };
  rec(node);
  return clean(out);
}
export const clean = s => String(s || "").replace(/\u00a0/g, " ").replace(/[ \t\r]+/g, " ").split("\n").map(l => l.trim()).filter(Boolean).join("\n");

export function extractEntries(html) {
  const { document } = parseHTML(html);
  const root = document.querySelector("#miserendalap") || document.body;
  const entries = [];
  const walk = (nodes, e) => {
    for (const n of nodes) {
      if (n.nodeType === 3) { const t = clean(n.textContent); if (t) e.parts.push({ t: "text", v: t, links: [] }); continue; }
      if (n.nodeType !== 1 || n.tagName === "SCRIPT" || n.tagName === "STYLE") continue;
      if (n.tagName === "TABLE") {
        const rows = [...n.querySelectorAll("tr")].map(tr => [...tr.querySelectorAll("td,th")].map(td => textOf(td))).filter(r => r.length >= 2);
        e.parts.push({ t: "table", rows }); continue;
      }
      const txt = textOf(n);
      if (n.getAttribute?.("id") === "frissites" || (/Friss[ií]tve/i.test(txt) && !n.querySelector("table"))) { e.parts.push({ t: "updated", v: txt }); continue; }
      if (n.querySelector("table") || n.querySelector("#frissites")) { walk(n.childNodes, e); continue; }
      if (txt) e.parts.push({ t: "text", v: txt, links: [...n.querySelectorAll("a[href]")].map(a => a.getAttribute("href")) });
    }
  };
  for (const h of root.querySelectorAll("h2")) {
    const a = h.querySelector("a");
    const e = { title: textOf(h), href: a ? a.getAttribute("href") : null, parts: [] };
    const nodes = []; let el = h.nextSibling;
    while (el && !(el.nodeType === 1 && (el.tagName === "H2" || el.querySelector?.("h2")))) { nodes.push(el); el = el.nextSibling; }
    walk(nodes, e);
    entries.push(e);
  }
  return entries;
}

/* ---------- Title → place and name ---------- */
const PLACE_ALIASES = { "szfvar": "Székesfehérvár" };
export function parseTitle(title, href) {
  let t = clean(title).replace(/\s+/g, " ");
  let type = "parish";
  const m = t.match(/\s*\((fília|filia|misézőhely)\)\s*$/i);
  if (m) { type = /mis/i.test(m[1]) ? "place" : "filia"; t = t.slice(0, m.index).trim(); }
  let place = t, name = "";
  const sp = t.match(/\s[–-]\s/);                      // spaced dash separates place from name
  if (sp) { place = t.slice(0, sp.index).trim(); name = t.slice(sp.index + sp[0].length).trim(); }
  if (/templomigazgatóság$/i.test(name)) { type = "directorate"; name = name.replace(/\s*templomigazgatóság$/i, ""); }
  else if (/plébánia$/i.test(name)) name = name.replace(/\s*plébánia$/i, "");
  // "Szfvár–Belváros", "Székesfehérvár-Kisfalud", "Ercsi Cukorgyár": settlement plus district
  const [first, ...rest] = place.split(/\s*[–-]\s*|\s+(?=[A-ZÁÉÍÓÖŐÚÜŰ])/);
  const settlement = PLACE_ALIASES[fold(first)] || first;
  const district = rest.join(" ").trim() || null;
  // Slug of the linked parish page, e.g. "szent-istvan-kiraly-plebania-erd-parkvaros-" → "erd parkvaros"
  const slug = (href || "").split("/").filter(Boolean).pop() || "";
  const slugPlace = (slug.match(/(?:plebania|templomigazgatosag|karoly)-(.+?)-?$/) || [])[1]?.replace(/-/g, " ") || null;
  return { settlement, district, name, type, slugPlace, title: clean(title) };
}
export function churchNameFor(p) {
  if (p.name) return /templom|kápolna|otthon|bazilika|székesegyház|kálvária/i.test(p.name) ? p.name : `${p.name}-templom`;
  return p.district ? `${p.settlement}-${p.district} misézőhely` : `${p.settlement} misézőhely`;
}

/* ---------- Seasons, date ranges and "nth weekday of the month" ---------- */
// A service can be limited to parts of the year with `valid` = "MM-DD/MM-DD[,MM-DD/MM-DD…]" (ranges may wrap
// the new year) and to some weeks of the month with `weeks` = [1..5, -1 = last], e.g. "minden hónap utolsó szombatján".
const MONTH_NAMES = ["januar", "februar", "marcius", "aprilis", "majus", "junius", "julius", "augusztus", "szeptember", "oktober", "november", "december"];
const MON_RE = MONTH_NAMES.join("|");
const DIM = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const md = (m, d) => String(m).padStart(2, "0") + "-" + String(Math.min(d, DIM[m - 1])).padStart(2, "0");
const DAY0 = Date.UTC(2024, 0, 1);                       // a leap year, so 02-29 has a slot
const doy = s => { const [m, d] = s.split("-").map(Number); return Math.round((Date.UTC(2024, m - 1, Math.min(d, DIM[m - 1])) - DAY0) / 864e5); };
const fromDoy = i => { const t = new Date(DAY0 + ((i + 366) % 366) * 864e5); return md(t.getUTCMonth() + 1, t.getUTCDate()); };
export function validToSet(valid) {
  const set = new Array(366).fill(false);
  for (const r of String(valid || "").split(",").filter(Boolean)) {
    const [a, b] = r.split("/"); let i = doy(a); const j = doy(b);
    for (let n = 0; n < 366; n++) { set[i] = true; if (i === j) break; i = (i + 1) % 366; }
  }
  return set;
}
export function setToValid(set) {
  if (set.every(Boolean) || !set.some(Boolean)) return null;
  let start = set.findIndex((v, i) => v && !set[(i + 365) % 366]);
  const out = []; let i = start;
  for (let n = 0; n < 366; n++) {
    if (set[i] && !set[(i + 365) % 366]) { let j = i; while (set[(j + 1) % 366] && (j + 1) % 366 !== i) j = (j + 1) % 366; out.push([i, j]); }
    i = (i + 1) % 366;
  }
  return out.sort((a, b) => a[0] - b[0]).map(([a, b]) => fromDoy(a) + "/" + fromDoy(b)).join(",");
}
const complementValid = valid => { const s = validToSet(valid); return setToValid(s.map(v => !v)); };
const unionValid = list => { const s = new Array(366).fill(false); for (const v of list.filter(Boolean)) validToSet(v).forEach((x, i) => { if (x) s[i] = true; }); return setToValid(s); };
const monthsValid = months => unionValid([...new Set(months)].map(m => md(m, 1) + "/" + md(m, 31)));
// "május 1-től szeptember 30-ig" (folded) → "05-01/09-30"
const RANGE_SRC = `(${MON_RE})\\s*(\\d{1,2})\\.?\\s*-?\\s*tol\\b[\\s,]*(${MON_RE})\\s*(\\d{1,2})\\.?\\s*-?\\s*ig\\b`;
const rangeFromMatch = m => md(MONTH_NAMES.indexOf(m[1]) + 1, +m[2]) + "/" + md(MONTH_NAMES.indexOf(m[3]) + 1, +m[4]);
const SEASON_OF = w => /^nyar/.test(w) ? "summer" : /^tel/.test(w) ? "winter" : /^osz/.test(w) ? "autumn" : /^tavasz/.test(w) ? "spring" : null;
// Season definitions a parish gives in its note, e.g. "Nyári miserend: május 1-től szeptember 1-ig."
export function seasonDefs(text) {
  const f = fold(text), defs = {};
  for (const m of f.matchAll(new RegExp(`\\b(nyar|osz|tel|tavasz)[a-z]*["”'*]*[^0-9]{0,40}?${RANGE_SRC}`, "g"))) {
    const k = SEASON_OF(m[1]); if (k && !defs[k]) defs[k] = rangeFromMatch([null, m[2], m[3], m[4], m[5]]);
  }
  // "május 1-től szeptember 1-ig" followed by "szeptember 1-től …": the end day belongs to the next season.
  const keys = Object.keys(defs);
  for (const k of keys) {
    const [a, b] = defs[k].split("/");
    if (keys.some(o => o !== k && defs[o].split("/")[0] === b)) defs[k] = a + "/" + fromDoy(doy(b) - 1);
  }
  // Only one side given: the other side is the rest of the year.
  const others = s => unionValid(Object.entries(defs).filter(([k]) => k !== s).map(([, v]) => v));
  if (defs.summer && !defs.winter) defs.winter = complementValid(others("winter"));
  else if (defs.winter && !defs.summer) defs.summer = complementValid(others("summer"));
  return defs;
}
export const isSeasonDefinitionLine = line => {
  const f = fold(line); const m = f.match(new RegExp(`\\b(nyar|osz|tel|tavasz)[a-z]*["”'*]*[^0-9]{0,40}?${RANGE_SRC}`));
  if (!m) return false;
  const rest = (f.slice(0, m.index) + f.slice(m.index + m[0].length)).replace(/miserend|idoszak|idoszam\w*|ertendo|azaz|["”'*.,:;()\s-]/g, "");
  return rest.length === 0;
};
const ORD = { elso: 1, masodik: 2, harmadik: 3, negyedik: 4, otodik: 5, utolso: -1 };
const DAYSTEM = { 1: "hetfo", 2: "kedd", 3: "szerda", 4: "csutortok", 5: "pentek", 6: "szombat", 0: "vasarnap" };
// "minden hónap utolsó szombatján", "1., 3. és 5. vasárnap", "elsőpénteken", "2. vasárnapja kivételével" → weeks of the month
export function weeksFrom(ctxF, day) {
  // Other weeks have something else (word service etc.), or the day is counted from another day: keep every week.
  if (/(utani|elotti|megelozo|koveto|egyebkent|tobbi|egyebkor|parosokban|paratlanokban|kethetente|minden masodik)\b/.test(ctxF)) return null;
  const stem = DAYSTEM[day]; if (!stem) return null;
  const m = ctxF.match(new RegExp(`((?:(?:\\d\\.|elso|masodik|harmadik|negyedik|otodik|utolso)[\\s,()]*(?:es\\s+)?)+)(?:het\\w*\\s+)?${stem}`));
  if (!m) return null;
  const after = ctxF.slice(m.index + m[0].length, m.index + m[0].length + 30);
  if (/\b(mise|szentmise)\s+utan/.test(after)) return null;       // "elsőpénteken mise után szentségimádás"
  let weeks = [...new Set([...m[1].matchAll(/(\d)\.|(elso|masodik|harmadik|negyedik|otodik|utolso)/g)].map(x => x[1] ? +x[1] : ORD[x[2]]))].filter(n => n === -1 || (n >= 1 && n <= 5));
  if (!weeks.length) return null;
  if (/kivetelevel/.test(after)) weeks = [1, 2, 3, 4, 5].filter(n => !weeks.includes(n));
  return weeks.sort((a, b) => a - b);
}

/* ---------- One table cell → services ---------- */
// "18.00", "18:00" and the cathedral's "18 h 00"
const TIME_RE = /(?<![\d.:])([01]?\d|2[0-3])(?:[.:]|\s*h\s*)([0-5]\d)(?!\d)/g;
const pad = (h, m) => String(h).padStart(2, "0") + ":" + m;
const hasRange = s => /(tól|től)\b|-ig\b|\big\b/.test(s);
// A specific yearly date ("Május 13-án", "december 8-án", "október 15-ét követő vasárnap", "május utolsó szombatján").
const isAnnual = s => new RegExp(`(${MONTHS})`, "i").test(s) && !hasRange(s) && !/\sés\s|minden/i.test(s);
const trimEnds = s => s.replace(/^[\s,;:–-]+|[\s,;:–-]+$/g, "");
const tidy = s => trimEnds(trimEnds(s.replace(/\s+/g, " ")).replace(/^\((.*)\)$/, "$1").replace(/\(\s*\)/g, "")).trim();
function noteFrom(text, { stripSeason, stripAdvent }) {
  let s = " " + text + " ";
  if (stripSeason) s = s.replace(/(^|[\s(;,])(télen|nyáron|ősszel|tavasszal|nyári\*?|téli|őszi|tavaszi)(?=[\s:);,]|$)\s*:?/gi, "$1 ");
  if (stripAdvent) s = s.replace(/\(?\s*(csak\s+)?(adventben|adventi\s+időszakban|advent)\s*(csak\s+)?(reggel\s*)?:?\s*\)?/gi, " ").replace(/\(?\s*rorát[eé]\s*\)?/gi, " ");
  s = s.replace(/\(\s*$/, "").replace(/^\s*\)/, "");
  const open = (s.match(/\(/g) || []).length, close = (s.match(/\)/g) || []).length;
  if (open > close) s = s.replace(/\(/, ""); if (close > open) s = s.replace(/\)/, "");
  return tidy(s) || null;
}
// Returns { rows: [{day, start, end, kind, period, note, feast}], extra: [lines for the church note] }
export function parseCell(dayLabel, text) {
  const out = { rows: [], extra: [] };
  const raw = clean(text);
  if (!raw || /^[-–]+$/.test(raw)) return out;
  const labelFold = fold(dayLabel).replace(/[^a-z ]/g, "").trim();
  const day = DAYS[labelFold];
  const labelFeast = day === undefined ? feastIn(dayLabel) : null;
  if (day === undefined && !labelFeast) { out.extra.push(`${clean(dayLabel)}: ${raw.replace(/\n/g, " ")}`); return out; }

  // Split into segments at ";" and line breaks; segments without a time attach to a neighbour.
  const segs = raw.split(/\s*;\s*|\n/).map(s => s.trim()).filter(Boolean);
  let carry = "", last = null;
  for (const seg of segs) {
    const times = [...seg.matchAll(TIME_RE)];
    if (!times.length) {
      if (/:\s*$/.test(seg) || !last) carry += " " + seg;      // "minden elsőpénteken:" → applies to the next time
      else last.extraNote = (last.extraNote ? last.extraNote + " " : "") + seg;
      continue;
    }
    let prevEnd = 0, pending = carry; carry = "";
    for (let i = 0; i < times.length; i++) {
      const tm = times[i], next = times[i + 1];
      let start = tm.index, endIdx = tm.index + tm[0].length;
      let prefix = pending + " " + seg.slice(prevEnd, start); pending = "";
      // time range "10.30-10.55"
      let endTime = null;
      const rangeM = seg.slice(endIdx).match(/^\s*[-–]\s*([01]?\d|2[0-3])(?:[.:]|\s*h\s*)([0-5]\d)/);
      let skipNext = false;
      if (rangeM) { endTime = pad(+rangeM[1], rangeM[2]); endIdx += rangeM[0].length; skipNext = !!next && next.index < endIdx; }
      const nxt = skipNext ? times[i + 2] : next;
      let suffix = seg.slice(endIdx, nxt ? nxt.index : seg.length);
      // An opening "(" before the next time belongs to that time: "7.00 (május és október: 18.30)"
      const openAt = suffix.lastIndexOf("(");
      if (nxt && openAt >= 0 && suffix.indexOf(")", openAt) < 0) suffix = suffix.slice(0, openAt);   // the next time's prefix (sliced from seg) already includes it
      const ctx = prefix + " " + suffix, ctxF = fold(ctx);
      const seasons = [...new Set([...ctxF.matchAll(/\b(nyaron|nyari|telen|teli|osszel|oszi|tavasszal|tavaszi)\b/g)].map(x => SEASON_OF(x[1].replace(/^osszel/, "osz"))))];
      const advent = /advent|rorat/.test(ctxF);
      const feast = labelFeast || feastIn(ctx);
      // Date range or months written next to the time: "18.00 július 1-től augusztus 31-ig", "(május és október: 18.30)",
      // "(páratlan hónapokban)".
      let valid = null, noteText = ctx;
      const rm = ctxF.match(new RegExp(RANGE_SRC));
      if (rm) valid = rangeFromMatch(rm);
      const ml = !valid && ctxF.match(new RegExp(`((?:${MON_RE})(?:\\s*(?:,|es)\\s*(?:${MON_RE}))*)\\s*(?:honapokban|honapban)?\\s*:`));
      if (ml) valid = monthsValid([...ml[1].matchAll(new RegExp(MON_RE, "g"))].map(x => MONTH_NAMES.indexOf(x[0]) + 1));
      if (!valid && !/(parosokban|paratlanokban|egyebkent|tobbi)/.test(ctxF)) {
        if (/\bparatlan honap/.test(ctxF)) valid = monthsValid([1, 3, 5, 7, 9, 11]);
        else if (/\bparos honap/.test(ctxF)) valid = monthsValid([2, 4, 6, 8, 10, 12]);
      }
      const row = { day, start: pad(+tm[1], tm[2]), end: endTime, kind: advent ? "rorate" : "mass",
        period: seasons.length === 1 ? seasons[0] : "all", valid, weeks: feast ? null : weeksFrom(ctxF, day), feast, monthList: !!ml,
        note: noteFrom(noteText, { stripSeason: true, stripAdvent: advent }) };
      if (!feast && isAnnual(ctx)) out.extra.push(`${clean(dayLabel)}: ${tidy(seg)}`);
      else { out.rows.push(row); last = row; }
      prevEnd = endIdx;
      if (skipNext) i++;
    }
  }
  // Notes after the last time on the following lines ("7.30\nA hónap 2. vasárnapján szentmise …")
  for (const r of out.rows) if (r.extraNote) { r.note = tidy([r.note, r.extraNote].filter(Boolean).join(" · ")); delete r.extraNote; }
  // "7.00 (május és október: 18.30)": the other time of that cell is for the rest of the year.
  const listed = out.rows.filter(r => r.monthList && r.valid);
  if (listed.length) { const rest = complementValid(unionValid(listed.map(r => r.valid)));
    for (const r of out.rows) if (!r.monthList && !r.valid && r.period === "all" && r.kind === "mass") r.valid = rest; }
  // "nem tanévben 6.15 ; … tanévben, azaz szeptember 1-től június 15-ig: 18.00"
  const school = out.rows.find(r => r.valid && /tanevben/.test(fold(r.note)) && !/nem tanevben/.test(fold(r.note)));
  if (school) for (const r of out.rows) if (!r.valid && /nem tanevben/.test(fold(r.note))) r.valid = complementValid(school.valid);
  for (const r of out.rows) delete r.monthList;
  // "18.00 ; nyári* 19.00": a plain time next to a summer-only one is the rest of the year's time.
  const sum = out.rows.filter(r => r.period === "summer"), win = out.rows.filter(r => r.period === "winter");
  if (sum.length === 1 && !win.length) { const i = out.rows.indexOf(sum[0]), prev = out.rows[i - 1];
    if (prev && prev.period === "all" && prev.kind === sum[0].kind && !prev.feast) prev.period = "winter"; }
  // "csak elsőpénteken télen 17.30; nyáron 18.30": the shared qualifier belongs to both seasonal rows.
  const seasonal = out.rows.filter(r => r.period !== "all");
  if (seasonal.length >= 2) {
    const shared = seasonal.map(r => r.note).find(Boolean);
    if (shared && seasonal.filter(r => !r.note).length === 1) for (const r of seasonal) r.note ||= shared;
  }
  return out;
}

/* ---------- Notes for the whole church ---------- */
const PHONE = /(\+36|\b06)[\s/-]?\d{1,2}[\s/-]?\d{3}[\s-]?\d{3,4}|\b\d{2}\/\d{3}[\s-]?\d{3,4}\b/;
const DROP_LINE = /^(irodaidő|irodai ügyek|gondnoki|szentségekkel kapcsolatban|máskor is lehetséges|megjegyzés:?)$|irodista|gondnok/i;
export function cleanNoteLines(text, links = []) {
  const goodLink = links.find(l => /^https?:\/\//.test(l) && !/%20/.test(l) && !/szfvar\.katolikus\.hu\/adattar\/B/.test(l));
  return clean(text).split("\n")
    .map(l => l.replace(/^megjegyzés:\s*/i, ""))
    .map(l => /:\s*ITT\s*$/.test(l) ? (goodLink ? l.replace(/ITT\s*$/, goodLink) : null) : l)
    .filter(l => l && !PHONE.test(l) && !DROP_LINE.test(l.trim()) && !/^friss[ií]tve/i.test(l));
}

/* ---------- Whole entry ---------- */
const dateOf = s => { const m = String(s || "").replace(/\s/g, "").match(/(20\d\d)\.(\d{1,2})\.(\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null; };
export function parseEntry(e) {
  const info = parseTitle(e.title, e.href);
  const regular = [], rorateRows = [], feastRows = [], extra = [], noteLines = [];
  let updated = null, label = null, seenMain = false; const labels = [];
  for (let i = 0; i < e.parts.length; i++) {
    const p = e.parts[i];
    if (p.t === "updated") { updated = dateOf(p.v) || updated; continue; }
    if (p.t === "text") {
      // A short text directly before a table is that table's label ("Lovasberény - advent", "Solymár - Kálvária").
      if (e.parts[i + 1]?.t === "table" && seenMain && p.v.length < 80) { label = p.v; labels.push(p.v); continue; }
      noteLines.push(...cleanNoteLines(p.v, p.links)); continue;
    }
    if (p.t !== "table") continue;
    const isAdvent = label && /advent/i.test(label);
    if (seenMain && label && !isAdvent) {
      // Another chapel or occasion listed under this church: keep it as a readable note line.
      for (const [d, txt] of p.rows) if (txt && !/^[-–]$/.test(txt)) extra.push(`${label.replace(/\s+/g, " ")}: ${d} ${txt.replace(/\n/g, " ")}`);
      label = null; continue;
    }
    for (const [d, txt] of p.rows) {
      const { rows, extra: ex } = parseCell(d, txt);
      extra.push(...ex);
      for (const r of rows) {
        if (isAdvent) {
          // In an Advent table, times that are not in the normal week are the Rorate Masses.
          const same = regular.some(x => x.day === r.day && x.start === r.start);
          if (!same) rorateRows.push({ ...r, kind: "rorate", note: r.note || null });
        } else if (r.feast) feastRows.push(r);
        else if (r.kind === "rorate") rorateRows.push(r);
        else regular.push(r);
      }
    }
    seenMain = true; label = null;
  }
  // Merge identical rows across days into one service with several days.
  const merge = rows => {
    const m = new Map();
    for (const r of rows) {
      const k = [r.kind, r.start, r.end, r.period, r.valid, JSON.stringify(r.weeks), r.note, r.feast].join("|");
      const x = m.get(k) || { kind: r.kind, days: [], start: r.start, end: r.end, period: r.period, valid: r.valid || null, weeks: r.weeks || null, note: r.note, feast: r.feast };
      if (r.day !== undefined && !x.days.includes(r.day)) x.days.push(r.day);
      m.set(k, x);
    }
    return [...m.values()].map(x => ({ ...x, days: x.feast ? [] : x.days.sort((a, b) => a - b) }));
  };
  // Seasons the parish defines itself ("Nyári miserend: május 1-től szeptember 1-ig") become date ranges.
  const defs = seasonDefs(e.parts.filter(p => p.t === "text").map(p => p.v).join("\n"));
  const services = [...merge(regular), ...merge(rorateRows), ...merge(feastRows)].map(s => {
    if (!s.valid && s.period !== "all" && defs[s.period]) s.valid = defs[s.period];
    if (!s.valid && (s.period === "autumn" || s.period === "spring")) s.valid = s.period === "autumn" ? "09-01/10-31" : "03-01/04-30";
    return s;
  });
  const lines = noteLines.filter(l => !(Object.keys(defs).length && isSeasonDefinitionLine(l)));
  const note = [...new Set([...lines, ...(extra.length ? ["Alkalmi misék és egyéb helyszínek:", ...extra] : [])])].join("\n").slice(0, 1500) || null;
  return { ...info, services, note, updated, href: e.href, seasons: defs, hints: [info.district, info.slugPlace, ...labels].filter(Boolean) };
}
