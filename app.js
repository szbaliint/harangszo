"use strict";
/* Harangszó public site.
   Data: Supabase (public_data RPC) when configured in config.js, otherwise the sample file data.js.
   Map: Google Maps when a key is configured, otherwise OpenStreetMap via Leaflet. Both cluster markers.
   Performance: per-day schedules and distances are cached; map markers are created once and only the
   ones whose visibility or colour changed are touched; the church list is kept in localStorage so
   repeat visits render immediately and refresh in the background. */

const CFG = window.HARANGSZO_CONFIG || {};
const real = v => typeof v === "string" && v && !v.startsWith("__");
const SB_URL = real(CFG.supabaseUrl) ? CFG.supabaseUrl.replace(/\/$/, "") : "";
const SB_KEY = real(CFG.supabaseAnonKey) ? CFG.supabaseAnonKey : "";
const LIVE = !!(SB_URL && SB_KEY);
// New publishable keys (sb_publishable_…) go only in the apikey header; legacy anon JWT keys also as Bearer.
const SB_HEADERS = { apikey: SB_KEY, ...(SB_KEY.startsWith("eyJ") ? { Authorization: `Bearer ${SB_KEY}` } : {}) };
const MAPS_KEY = real(CFG.googleMapsKey) ? CFG.googleMapsKey : "";
const REPO = CFG.repo || "szbaliint/harangszo";
const LIST_LIMIT = 60;
const CACHE_KEY = "harangszo-data-v2";
const C = window.LitCal;

/* ---------- Helpers ---------- */
const DAYN = ["Vasárnap", "Hétfő", "Kedd", "Szerda", "Csütörtök", "Péntek", "Szombat"];
const DAY_SHORT = ["V", "H", "K", "Sze", "Cs", "P", "Szo"];
const MON = ["jan.", "febr.", "márc.", "ápr.", "máj.", "jún.", "júl.", "aug.", "szept.", "okt.", "nov.", "dec."];
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Midnight ("00:00", e.g. the Christmas Eve midnight Mass) belongs to the end of the evening, so it sorts last and shows as 24:00.
const mins = t => { if (!t) return 0; const [h, m] = t.split(":").map(Number); return h === 0 && m === 0 ? 1440 : h * 60 + m; };
const showT = t => t === "00:00" ? "24:00" : t;
const ymd = C.ymd;
const fold = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const km = (a, b) => { const R = 6371, r = x => x * Math.PI / 180, dLa = r(b[0] - a[0]), dLo = r(b[1] - a[1]); const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const massWord = c => c.rite === "gk" ? "Szent Liturgia" : "Szentmise";
const riteName = c => c.rite === "gk" ? "görögkatolikus" : "római katolikus";
const range = (a, b) => b ? a + "–" + b : a;
const SOURCES = { szfvar: "Székesfehérvári Egyházmegye miserendje", miserend: "miserend.hu" };
// Escape, then turn bare web addresses into links (notes come from parishes and the community).
const linkify = t => esc(t).replace(/(https?:\/\/[^\s<]+[^\s<.,;:)])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
const longDate = iso => { const d = new Date(iso + "T12:00"); return isNaN(d) ? iso : `${d.getFullYear()}. ${MON[d.getMonth()]} ${d.getDate()}.`; };
const shortDate = d => `${MON[d.getMonth()]} ${d.getDate()}.`;
// "H, K, Sze" or "H–Szo" for a run of consecutive days (Monday first).
function daysText(days) {
  const order = [1, 2, 3, 4, 5, 6, 0].filter(d => days.includes(d));
  if (order.length === 7) return "minden nap";
  const idx = order.map(d => (d + 6) % 7), consecutive = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  return consecutive && order.length > 2 ? DAY_SHORT[order[0]] + "–" + DAY_SHORT[order[order.length - 1]] : order.map(d => DAY_SHORT[d]).join(", ");
}

/* ---------- Data ---------- */
let CHURCHES = [], BY_ID = new Map();
// Internal shape: {id,name,city,addr,rite,lat,lon,web,phone,onlyServices,hours:[{days,o,c}],
//   svc:[{k:'mass'|'conf'|'ador'|'rorate', d:[], t, u, n, p:'all'|'summer'|'winter', feast:null|key}], feastSunday:[], ev:[{date,t,title,n}]}
// A church photograph (Wikimedia Commons or the parish's own), with its credit line and, for Commons, its file page.
const httpsUrl = v => typeof v === "string" && /^https:\/\//.test(v) ? v : "";
const photoOf = c => httpsUrl(c.photo_url) ? { src: c.photo_url, credit: c.photo_credit || "", page: httpsUrl(c.photo_page) } : null;
const KIND = { mass: "mass", confession: "conf", adoration: "ador", rorate: "rorate", prayer: "prayer" };
function fromSample(c) {
  const svc = [
    ...c.mass.map(m => ({ k: "mass", d: m.d, t: m.t, u: null, n: m.n, p: m.p || "all", feast: null })),
    ...c.conf.map(m => ({ k: "conf", d: m.d, t: m.f, u: m.u, n: m.n, p: m.p || "all", feast: null })),
    ...(c.ador || []).map(m => ({ k: "ador", d: m.d, t: m.f, u: m.u, n: m.n, p: "all", feast: null })),
    ...(c.rorate || []).map(m => ({ k: "rorate", d: m.d, t: m.t, u: null, n: m.n, p: "all", feast: null })),
    ...Object.entries(c.feasts || {}).flatMap(([key, rows]) => rows.map(m => ({ k: m.k, d: [], t: m.t, u: m.u || null, n: m.n, p: "all", feast: key }))),
  ];
  return { id: c.id, name: c.name, city: c.city, addr: c.addr, rite: c.rite, lat: c.lat, lon: c.lon,
    onlyServices: !c.hours, hours: c.hours || [], svc, feastSunday: c.feastSunday || [], ev: c.ev || [], imp: c.imp ?? 60,
    web: c.web, phone: c.phone, note: c.note || "", approx: !!c.approx, photo: photoOf(c) };
}
function fromDb(c) {
  return { id: c.id, photo: photoOf(c), name: c.name, city: c.city || "", addr: c.address || "", rite: c.rite, lat: c.lat, lon: c.lon,
    web: c.website, phone: c.phone, onlyServices: !!c.open_only_services,
    hours: (c.hours || []).map(h => ({ days: h.days, o: h.opens, c: h.closes })),
    svc: (c.services || []).map(s => ({ k: KIND[s.kind] || "mass", d: s.days || [], t: s.start, u: s.end || null, n: s.note, p: s.period || "all", feast: s.feast || null,
      v: s.valid || null, w: s.weeks && s.weeks.length ? s.weeks : null, e: s.every || null, a: s.anchor || null, g: s.tags || [],
      cel: s.celebrant || "", pl: s.place || "", pid: s.place_id || null, skip: !!s.skip })),
    feastSunday: c.feast_sunday || [], imp: c.imp ?? 30,
    note: c.schedule_note || "", parishUpdated: c.parish_updated || null, source: c.schedule_source || null, sourceUrl: c.schedule_source_url || null, updated: c.schedule_updated || null, approx: !!c.location_approx,
    ev: (c.events || []).map(e => ({ date: e.date, t: e.start || "", title: e.title, n: e.note })),
    // Times for given dates from the parish's own weekly schedule; on those dates they replace the regular rules.
    dated: (c.dated || []).map(d => ({ date: d.date, k: KIND[d.kind] || "mass", d: [], t: d.start, u: d.end || null, n: d.note, g: d.tags || [], url: d.url || null,
      cel: d.celebrant || "", pl: d.place || "", pid: d.place_id || null })) };
}
function setChurches(list) {
  CHURCHES = list;
  BY_ID = new Map(list.map(c => [c.id, c]));
  // A time held at another church of the list ("a temetőkápolnában") also shows there, and counts there on the map.
  for (const c of list) for (const key of ["svc", "dated"]) for (const s of c[key] || []) {
    if (s.guestOf || !s.pid) continue;
    const at = BY_ID.get(s.pid); if (!at) continue;
    s.away = at.name; (at[key] ||= []).push({ ...s, pid: null, pl: "", away: null, guestOf: c.name, guestId: c.id });
  }
  for (const c of list) { c.key = fold(c.name + " " + c.city + " " + c.addr); c.score = c.imp + (c.svc.some(s => !s.feast) ? 25 : 0); }
  // Kinds of Mass worth filtering by: the ones at least a few churches have (languages first).
  const n = new Map();
  for (const c of list) for (const t of new Set(c.svc.filter(s => s.k === "mass" || s.k === "rorate").flatMap(tagsOf))) n.set(t, (n.get(t) || 0) + 1);
  TAG_OPTIONS = [...n].filter(([t, k]) => k >= 2 && !["irregular", "word", "confession", "organ", "choir"].includes(t))
    .sort((a, b) => a[0].startsWith("lang:") - b[0].startsWith("lang:") || b[1] - a[1]).map(([t]) => t);
  if (S.f.tag && !TAG_OPTIONS.includes(S.f.tag)) S.f.tag = "";
  dayCache.clear(); distCache.origin = null; nearCache.key = "";
}
let TAG_OPTIONS = [];
const readCache = () => { try { return localStorage.getItem(CACHE_KEY); } catch (e) { return null; } };
const writeCache = text => { try { if (text.length < 4.5e6) localStorage.setItem(CACHE_KEY, text); } catch (e) { } };
async function fetchLive() {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/public_data`, { method: "POST", headers: { ...SB_HEADERS, "Content-Type": "application/json" }, body: "{}" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}

/* ---------- Schedule for one church on one day ---------- */
const hasSchedule = c => c.svc.some(s => !s.feast) || (c.dated || []).length > 0;
const isRegular = s => !s.feast;
function dayContext(date) {
  return { date, dow: date.getDay(), key: ymd(date), summer: C.isSummerTime(date), advent: C.inAdvent(date), feasts: C.feastsOn(date), holiday: C.isHoliday(date) };
}
// Seasons: a date range (`v`) wins; otherwise the period's own rule (clock change, Advent, Lent, school year… see calendar.js).
const seasonOk = (s, ctx) => C.inPeriod(ctx.date, s.p, s.v);
// Week of the month and "every n-th week".
const weekOk = (s, ctx) => C.weekOk(ctx.date, s.w) && C.everyOk(ctx.date, s.e, s.a);
const tagsOf = s => s.g || [];
// "P. Kamill · 📍 Temetőkápolna" under a time; "a Plébánia miséje" when another church holds it here.
const whoWhere = s => [s.cel ? "Celebrál: " + s.cel : "", s.place || s.away || s.pl ? "Helyszín: " + (s.place || s.away || s.pl) : "", s.guestOf ? s.guestOf + " tartja" : ""].filter(Boolean).join(" · ");
const tagsHTML = g => g && g.length ? `<span class="tags">${g.map(t => `<span class="tag ${t.startsWith("lang:") ? "lang" : t === "irregular" ? "warn" : ""}">${esc(C.tagLabel(t))}</span>`).join("")}</span>` : "";
function dayInfo(c, ctx) {
  let rows, feast = null, feastMode = null;
  // Times another parish holds here (guests) are added on top; they never replace this church's own schedule.
  const dated = (c.dated || []).filter(d => d.date === ctx.key && !d.guestOf);
  const regularOn = s => isRegular(s) && seasonOk(s, ctx) && weekOk(s, ctx) && s.d.includes(ctx.dow) && (s.k !== "rorate" || ctx.advent) && !(s.skip && ctx.holiday);
  const guests = [...(c.dated || []).filter(d => d.date === ctx.key && d.guestOf), ...c.svc.filter(s => s.guestOf && regularOn(s))];
  // A row for this very feast wins over a row for all holy days / public holidays.
  const allCustom = ctx.feasts.length ? c.svc.filter(s => s.feast && !s.guestOf && ctx.feasts.includes(s.feast)) : [];
  const own = allCustom.filter(s => !C.isGroup(s.feast)), custom = own.length ? own : allCustom;
  const sundayFeast = ctx.feasts.find(k => c.feastSunday.includes(k) && (!custom.length || !C.isGroup(k)));
  const feastName = ctx.feasts.length ? C.FEAST_BY_KEY[ctx.feasts[0]]?.name : null;
  if (dated.length) { rows = dated; feastMode = "dated"; feast = feastName; }
  else if (custom.length) { rows = custom; feast = feastName; feastMode = "custom"; }
  else if (sundayFeast) { rows = c.svc.filter(s => isRegular(s) && !s.guestOf && s.k !== "rorate" && seasonOk(s, ctx) && !s.w && !s.e && s.d.includes(0)); feast = feastName; feastMode = "sunday"; }
  else rows = c.svc.filter(s => !s.guestOf && regularOn(s));
  rows = [...rows, ...guests];
  const items = rows.map(s => ({ k: s.k, t: s.t, end: s.k === "mass" || s.k === "rorate" ? null : s.u, n: s.k === "prayer" ? "" : s.n, g: tagsOf(s),
    cel: s.cel || "", place: s.away || s.pl || "", away: !!s.away, guestOf: s.guestOf || "",
    what: s.k === "mass" ? massWord(c) : s.k === "rorate" ? "Rorate" : s.k === "conf" ? "Gyóntatás" : s.k === "prayer" ? (s.n || "Ájtatosság") : "Szentségimádás" }));
  for (const e of c.ev) if (e.date === ctx.key) items.push({ k: "ev", t: e.t, end: null, what: e.title, n: e.n, g: [] });
  items.sort((a, b) => mins(a.t) - mins(b.t));
  return { items, feast, feastMode, datedUrl: dated[0]?.url || null,
    hasMass: items.some(i => !i.away && (i.k === "mass" || i.k === "rorate")), hasConf: items.some(i => !i.away && i.k === "conf"), hasRorate: items.some(i => !i.away && i.k === "rorate") };
}
// Cache of dayInfo per date (a few dates at most), so typing and filtering don't recompute schedules.
const dayCache = new Map();
function dayInfoCached(c, ctx) {
  let m = dayCache.get(ctx.key);
  if (!m) { if (dayCache.size > 8) dayCache.clear(); m = new Map(); dayCache.set(ctx.key, m); }
  let v = m.get(c.id); if (!v) { v = dayInfo(c, ctx); m.set(c.id, v); }
  return v;
}
const distCache = { origin: null, map: new Map() };
function distOf(c) {
  const key = S.origin + ORIGINS[S.origin].join();
  if (distCache.origin !== key) { distCache.origin = key; distCache.map = new Map(); }
  let d = distCache.map.get(c.id); if (d === undefined) { d = km(ORIGINS[S.origin], [c.lat, c.lon]); distCache.map.set(c.id, d); }
  return d;
}
function openState(c, now) {
  if (c.onlyServices) return { known: false, label: "Szertartásokkor nyitva" };
  if (!c.hours.length) return { known: false, label: "" };
  const dow = now.getDay(), m = now.getHours() * 60 + now.getMinutes();
  const h = c.hours.find(x => x.days.includes(dow));
  if (!h) return { known: true, open: false, label: "Ma zárva" };
  if (m >= mins(h.o) && m < mins(h.c)) return { known: true, open: true, label: "Nyitva " + h.c + "-ig" };
  if (m < mins(h.o)) return { known: true, open: false, label: "Nyit " + h.o + "-kor" };
  return { known: true, open: false, label: "Zárva" };
}
function hoursText(c, dow) {
  if (c.onlyServices) return "Szertartásokkor";
  if (!c.hours.length) return "–";
  const h = c.hours.find(x => x.days.includes(dow)); return h ? h.o + "–" + h.c : "Zárva";
}

/* ---------- State ---------- */
// tab: "most" (home: the nearest church with a Mass to come), "map", "saved". sel: the open church page.
// pick: the church tapped on the phone map (shown in its bottom panel). search: the search panel is open.
const S = { q: "", dayOffset: 0, origin: "Budapest", f: { open: false, mass: false, conf: false, ev: false, rorate: false, tag: "" },
  sel: null, pick: null, loading: true, error: "", tab: "most", search: false, moreOpen: false, weekOpen: false };
try { const saved = JSON.parse(localStorage.getItem("harangszo") || "{}"); if (saved.origin && ORIGINS[saved.origin]) S.origin = saved.origin; } catch (e) { }
const now = () => new Date();
const selDate = () => { const d = now(); d.setDate(d.getDate() + S.dayOffset); return d; };
const isToday = () => S.dayOffset === 0;
let lastRows = [];
// Saved ("Mentett") churches: ids in localStorage, nothing on the server. Works in memory when storage is blocked.
const Saved = (() => {
  const KEY = "harangszo.saved.v1"; let set = null;
  const load = () => {
    if (set) return set;
    let arr = [];
    try { const v = JSON.parse(localStorage.getItem(KEY) || "[]"); if (Array.isArray(v)) arr = v.map(Number).filter(Number.isFinite); } catch (e) { }
    return set = new Set(arr);
  };
  const store = () => { try { localStorage.setItem(KEY, JSON.stringify([...set])); } catch (e) { } };
  return {
    ids: () => [...load()],
    has: id => load().has(id),
    toggle(id) { const s = load(); if (s.has(id)) s.delete(id); else s.add(id); store(); return s.has(id); },
  };
})();

function filtered() {
  const ctx = dayContext(selDate()), q = fold(S.q.trim()), n = now();
  const wk = C.addDays(ctx.date, 7), wkEnd = ymd(wk), today = ctx.key;
  const out = [];
  for (const c of CHURCHES) {
    if (q && !c.key.includes(q)) continue;
    const di = dayInfoCached(c, ctx);
    if (S.f.mass && !di.hasMass) continue;
    if (S.f.conf && !di.hasConf) continue;
    if (S.f.rorate && !di.hasRorate) continue;
    if (S.f.tag && !di.items.some(i => (i.k === "mass" || i.k === "rorate") && i.g.includes(S.f.tag))) continue;
    if (S.f.ev && !c.ev.some(e => e.date >= today && e.date < wkEnd)) continue;
    let os = null;
    if (S.f.open) { os = openState(c, n); if (!(os.known && os.open)) continue; }
    out.push({ c, di, dist: distOf(c), os });
  }
  out.sort((a, b) => a.dist - b.dist);
  return lastRows = out;
}
function upcoming(items) {
  if (!isToday()) return items;
  const m = now().getHours() * 60 + now().getMinutes();
  return items.filter(i => !i.t || mins(i.end || i.t) >= m);
}

// The next Mass or confession of the day (from now on, if it is today): its time and kind, for markers and cards.
function nextOf(di) {
  const m = now().getHours() * 60 + now().getMinutes();
  // Times this parish holds elsewhere count at that place, not here.
  const items = di.items.filter(i => (i.k === "mass" || i.k === "rorate" || i.k === "conf") && i.t && !i.away);
  const up = isToday() ? items.filter(i => mins(i.end || i.t) >= m) : items;
  const i = up[0];
  return i ? { t: showT(i.t), cls: i.k === "conf" ? "conf" : "mass", k: i.k } : { t: "–", cls: "none", k: null };
}

/* ---------- Words, numbers, the church year ---------- */
const MONTHS = ["január", "február", "március", "április", "május", "június", "július", "augusztus", "szeptember", "október", "november", "december"];
const NEAR_KM = 25;
const kmText = d => d < 1 ? Math.round(d * 1000 / 10) * 10 + " m" : (d < 10 ? d.toFixed(1).replace(".", ",") : Math.round(d)) + " km";
// Walking time at 5 km/h, only where walking makes sense.
const distText = d => kmText(d) + (d < 3 ? `, ${Math.max(1, Math.round(d / 5 * 60))} perc gyalog` : "");
const KIND_WORD = { mass: "mise", rorate: "rorate", conf: "gyónás", ador: "szentségimádás", prayer: "ájtatosság", ev: "esemény" };
const nowMin = () => { const n = now(); return n.getHours() * 60 + n.getMinutes(); };
const daysBetween = (a, b) => Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 864e5);
// The liturgical week of a date: "Évközi 32. hét", "Advent 2. hete", "Nagyböjt 3. hete", "Nagyhét", "Húsvéti idő 4. hete"…
function litWeek(date) {
  const y = date.getFullYear(), d = C.addDays(date, 0), E = C.easter(y), adv = C.adventStart(y), ash = C.addDays(E, -46), palm = C.addDays(E, -7);
  const nth = from => Math.floor(daysBetween(from, d) / 7) + 1;
  if (d >= adv && d <= new Date(y, 11, 24)) return `Advent ${nth(adv)}. hete`;
  if (C.inChristmas(d)) return "Karácsonyi idő";
  if (d >= ash && d < palm) return d < C.addDays(E, -42) ? "Nagyböjt" : `Nagyböjt ${nth(C.addDays(E, -42))}. hete`;
  if (d >= palm && d < E) return "Nagyhét";
  if (d >= E && d <= C.addDays(E, 49)) return d < C.addDays(E, 7) ? "Húsvét nyolcada" : `Húsvéti idő ${nth(E)}. hete`;
  if (d < ash) { const ep = new Date(y, 0, 6), bapt = C.addDays(ep, 7 - ep.getDay()); return `Évközi ${nth(bapt)}. hét`; }
  // After Pentecost: counted back from Christ the King, the 34th week.
  const king = C.addDays(adv, -7), sunday = C.addDays(d, -d.getDay());
  return `Évközi ${34 - Math.round(daysBetween(sunday, king) / 7)}. hét`;
}
const dayLine = d => `${DAYN[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}. · ${litWeek(d)}`;
const inLong = d => d < 60 ? `${d} perc múlva` : `${Math.floor(d / 60)} óra${d % 60 ? ` ${d % 60} perc` : ""} múlva`;
function kindName(c, i) {
  if (i.k === "mass") return c.rite === "gk" ? "Szent Liturgia" : i.g.includes("vigil") ? "Előesti szentmise" : "Szentmise";
  if (i.k === "rorate") return "Rorate szentmise";
  if (i.k === "conf") return "Gyóntatás";
  if (i.k === "ador") return "Szentségimádás";
  return i.what;
}
// What else to know about a time: until when, "vasárnapra érvényes", the parish's note, the kind of Mass, who and where.
const noteOf = i => [i.end ? showT(i.end) + "-ig" : "", i.g.includes("vigil") ? "vasárnapra érvényes" : "", i.k === "prayer" || i.k === "ev" ? "" : i.n,
  ...i.g.filter(t => t !== "vigil").map(C.tagLabel), whoWhere(i)].filter(Boolean);
// The big time: 64px light, the kind beside it (red only when it is the next one, today), its notes and "N perc múlva".
function whenHTML(c, i, today, id) {
  const m = nowMin(), diff = mins(i.t) - m, running = today && i.end && diff <= 0 && mins(i.end) > m;
  const extra = [...noteOf(i), today && diff > 0 && diff < 180 ? inLong(diff) : "", running ? "most tart" : ""].filter(Boolean).join(" · ");
  return `<div class="when" id="${id}"><b class="big">${esc(showT(i.t))}</b><span class="when-side"><em${today ? ' class="now"' : ""}>${esc(kindName(c, i))}</em>`
    + `${extra ? `<span>${esc(extra)}</span>` : ""}</span></div>`;
}
const dirOf = c => `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lon}`;
const webOf = c => c.web ? (/^https?:/i.test(c.web) ? c.web : "https://" + c.web) : "";
const whereOf = c => [c.city, c.addr].filter(Boolean).join(", ");

/* ---------- Nearby now: the church for Most, the times after it ---------- */
const MASSK = ["mass", "rorate"], ALLK = ["mass", "rorate", "conf", "ador", "prayer"];
const upcomingOf = (di, kinds) => { const m = nowMin(); return di.items.filter(i => i.t && !i.away && kinds.includes(i.k) && mins(i.end || i.t) >= m); };
let nearCache = { key: "", v: null };
function nearby() {
  const ctx = dayContext(now()), o = ORIGINS[S.origin], key = [ctx.key, nowMin(), S.origin, o.join(), CHURCHES.length].join("|");
  if (nearCache.key === key) return nearCache.v;
  const rows = [];
  for (const c of CHURCHES) { const dist = distOf(c); if (dist <= NEAR_KM) rows.push({ c, dist }); }
  rows.sort((a, b) => a.dist - b.dist);
  let hero = null; const times = [];
  rows.forEach((r, n) => {
    if (hero && n >= 40) return;
    r.di = dayInfoCached(r.c, ctx);
    if (!hero) { const i = upcomingOf(r.di, MASSK)[0]; if (i) hero = { r, i }; }
    if (n < 40) for (const i of upcomingOf(r.di, ALLK)) times.push({ r, i });
  });
  const next = times.filter(x => !(hero && x.i === hero.i)).sort((a, b) => mins(a.i.t) - mins(b.i.t) || a.r.dist - b.r.dist).slice(0, 30);
  return (nearCache = { key, v: { hero, next, any: rows.length > 0 } }).v;
}
const nextId = () => S.loading || S.error ? null : nearby().hero?.r.c.id ?? null;

/* ---------- Shared pieces: photo, buttons, rows ---------- */
const svgI = (d, w = 22) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  heart: svgI('<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>', 20),
  back: svgI('<path d="M15 5l-7 7 7 7"/>'),
  share: svgI('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M8 11H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-2"/>', 20),
};
const saveLabel = on => on ? "Eltávolítás a kedvencek közül" : "Mentés a kedvencek közé";
const saveBtnHTML = (c, id) => { const on = Saved.has(c.id); return `<button class="pill round savebtn" id="${id}" type="button" data-save="${c.id}" aria-pressed="${on}" aria-label="${saveLabel(on)}" title="${saveLabel(on)}">${ICONS.heart}</button>`; };
function setSaveBtn(b, on) { b.setAttribute("aria-pressed", String(on)); b.setAttribute("aria-label", saveLabel(on)); b.title = saveLabel(on); }
// A church photograph edge to edge, with the buttons over it and its credit in the corner. One <img> per photo is kept,
// so the minute re-render never reloads or flashes it. A photo that fails to load is dropped: the page shows no image.
const hasPhoto = c => !!(c && c.photo && c.photo.src && !c.photo.failed);
const imgs = new Map();
const photoHTML = (c, top, cls = "") => `<div class="ph" data-photo="${c.id}"><div class="ph-top ${cls}">${top}</div>`
  + `${!c.photo.credit ? "" : c.photo.page ? `<a class="ph-credit" href="${esc(c.photo.page)}" target="_blank" rel="noopener noreferrer">${esc(c.photo.credit)}</a>`
    : `<span class="ph-credit">${esc(c.photo.credit)}</span>`}</div>`;
const plainTop = (top, cls = "") => `<div class="top-plain ${cls}">${top}</div>`;
function fillPhotos(root) {
  root.querySelectorAll(".ph[data-photo]").forEach(slot => {
    const c = BY_ID.get(+slot.dataset.photo); if (!hasPhoto(c)) return;
    let img = imgs.get(c.photo.src);
    if (!img) {
      img = document.createElement("img");
      img.className = "ph-img"; img.setAttribute("loading", "eager"); img.decoding = "async"; img.width = 1000; img.height = 750;
      img.addEventListener("error", () => { c.photo.failed = true; imgs.delete(c.photo.src); render(); });
      img.src = c.photo.src; imgs.set(c.photo.src, img);
    }
    img.alt = c.name; slot.prepend(img);
  });
}
// One row style everywhere: time | church, street | distance.
const rowHTML = (id, t, name, sub, dist, cur) => `<li><button class="row" type="button" data-id="${id}"${cur ? ' aria-current="true"' : ""}>`
  + `<span class="r-t">${esc(t)}</span><span class="r-n"><span class="r-name">${esc(name)}</span>${sub ? `<small>${esc(sub)}</small>` : ""}</span>`
  + `<span class="r-d">${esc(dist)}</span></button></li>`;
const timeWord = (c, i) => i.k === "prayer" ? i.what : i.k === "mass" && c.rite === "gk" ? "liturgia" : KIND_WORD[i.k];
// In a list: the next time of the selected day (a time the filters ask for first), else why there is none.
function rowNext(r) {
  const isMass = i => i.k === "mass" || i.k === "rorate", any = S.f.conf || S.f.rorate || S.f.tag || S.f.mass;
  const wanted = i => (S.f.conf && i.k === "conf") || (S.f.rorate && i.k === "rorate") || (S.f.tag ? isMass(i) && i.g.includes(S.f.tag) : S.f.mass && isMass(i));
  const i = upcoming(r.di.items).find(i => i.t && !i.away && i.k !== "ev" && (!any || wanted(i)));
  if (i) return { t: showT(i.t), word: timeWord(r.c, i) };
  return { t: "–", word: !hasSchedule(r.c) && !r.di.feastMode ? "még nincs időpont" : isToday() ? "ma már nincs" : "nincs alkalom" };
}
function listRowHTML(r) {
  const n = rowNext(r), os = S.f.open && isToday() ? (r.os || openState(r.c, now())) : null;
  return rowHTML(r.c.id, n.t, r.c.name, [n.word, os && os.label, whereOf(r.c)].filter(Boolean).join(" · "), kmText(r.dist), S.sel === r.c.id);
}
const stateHTML = () => `<div class="ui-empty"><p>${S.error ? esc(S.error) : "Templomok betöltése…"}</p></div>`;

/* ---------- Views and motion ---------- */
const app = $("#app"), col = $("#col"), panel = $("#panel"), isDesktop = () => window.matchMedia("(min-width:900px)").matches;
const motionOk = () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function setView() {
  const view = S.sel ? "church" : S.tab;
  app.dataset.view = view; app.dataset.tab = S.tab;
  document.querySelectorAll(".tab").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tab === S.tab)));
  $("#mapui").inert = !isDesktop() && view !== "map";
}
/* The column's content changes inside a view transition (styles.css "Motion"); the map underneath never takes part.
   open: the church page slides in from the right; back: it leaves along the same path; tab: 150ms cross-fade.
   Reduced motion: every one of them is a 150ms cross-fade. */
let vtSeq = 0;
function withTransition(update, kind = "tab") {
  const root = document.documentElement, cls = "vt-" + kind;
  if (document.startViewTransition) {
    let ran = false;
    const run = () => { ran = true; update(); };
    try {
      root.classList.remove("vt-open", "vt-back", "vt-tab"); root.classList.add(cls);
      const seq = ++vtSeq, t = document.startViewTransition(run);
      t.ready.catch(() => { }); t.updateCallbackDone.catch(() => { });
      t.finished.catch(() => { }).finally(() => { if (seq === vtSeq) root.classList.remove(cls); });
      return;
    } catch (e) { root.classList.remove(cls); if (!ran) update(); return; }
  }
  // No View Transitions: the new content comes in with the same motion as a keyframe animation.
  update();
  col.classList.remove("c-open", "c-back", "c-tab"); void col.offsetWidth; col.classList.add("c-" + kind);
}
col.addEventListener("animationend", e => { if (e.target === col) col.classList.remove("c-open", "c-back", "c-tab"); });
function openTab(tab) {
  if (S.search) closeSearch(false);
  if (tab === S.tab && !S.sel) { col.scrollTo({ top: 0, behavior: motionOk() ? "smooth" : "auto" }); return; }
  S.tab = tab; S.sel = null; S.pick = null; S.weekOpen = false;
  Track.ev("tab", tab); // a switch back to Most counts too (track() knows it from migration 014); opening on Most does not
  withTransition(render, "tab");
}
// Tabs answer on pointer-down, like a native tab bar; the click that follows is ignored (keyboard clicks still work).
(function tabs() {
  let downOn = null, t = null;
  $("#tabs").addEventListener("pointerdown", e => {
    const b = e.target.closest(".tab"); if (!b || e.button) return;
    downOn = b.dataset.tab; clearTimeout(t); t = setTimeout(() => downOn = null, 800); openTab(b.dataset.tab);
  });
  $("#tabs").addEventListener("click", e => {
    const b = e.target.closest(".tab"); if (!b) return;
    if (downOn === b.dataset.tab) { downOn = null; return; }
    openTab(b.dataset.tab);
  });
})();
function select(id, { week = false } = {}) {
  const c = BY_ID.get(id); if (!c) return;
  if (S.search) closeSearch(false);
  S.sel = id; S.pick = null; S.weekOpen = week;
  if (LIVE) Track.once("view", id);
  MapView.focus(c.lat, c.lon, 15);
  withTransition(render, "open");
}
function back() { S.sel = null; S.weekOpen = false; withTransition(render, "back"); }
document.addEventListener("keydown", e => {
  if (e.key !== "Escape" || $("#suggest").open || $("#install").open) return; // the sheets close themselves
  if (S.search) { e.preventDefault(); closeSearch(); return; }
  if (S.sel) back();
});

/* ---------- Search panel: field, filters, results ---------- */
const searchEl = $("#search"); let searchOpener = null;
function openSearch(opener) {
  if (S.search) return;
  S.search = true; searchOpener = opener || document.activeElement;
  searchEl.inert = false; searchEl.dataset.open = "true"; Track.ev("tab", "list");
  renderSearch();
  $("#q").focus({ preventScroll: true });
}
function closeSearch(restore = true) {
  if (!S.search) return;
  S.search = false; searchEl.dataset.open = "false"; searchEl.inert = true;
  if (restore && searchOpener && searchOpener.isConnected) searchOpener.focus({ preventScroll: true });
}
$("#search-done").addEventListener("click", () => closeSearch());
$("#map-search").addEventListener("click", e => openSearch(e.currentTarget));
function dayLabel(off) { const d = new Date(); d.setDate(d.getDate() + off); return off === 0 ? "Ma" : off === 1 ? "Holnap" : DAYN[d.getDay()] + ", " + shortDate(d); }
const filterCount = () => (S.f.open ? 1 : 0) + (S.f.ev ? 1 : 0) + (S.f.rorate ? 1 : 0) + (S.f.tag ? 1 : 0);
function renderFilters() {
  const ctx = dayContext(selDate()), kind = S.f.conf ? "conf" : S.f.mass ? "mass" : "", n = filterCount();
  const opts = [...Array(8).keys()].map(i => `<option value="${i}" ${i === S.dayOffset ? "selected" : ""}>${dayLabel(i)}</option>`).join("");
  const ors = Object.keys(ORIGINS).map(k => `<option ${k === S.origin ? "selected" : ""}>${esc(k)}</option>`).join("")
    + (navigator.geolocation && !ORIGINS["Saját helyzetem"] ? `<option value="__me">Saját helyzetem…</option>` : "");
  const tagLabel = t => esc(C.tagLabel(t)[0].toUpperCase() + C.tagLabel(t).slice(1));
  const tog = (k, label) => `<label class="s-opt"><span>${label}</span><input class="ui-toggle" type="checkbox" data-f="${k}"${S.f[k] ? " checked" : ""}></label>`;
  $("#s-filters").innerHTML = `<div class="ui-seg s-kind" role="group" aria-label="Alkalom">${[["", "Mind"], ["mass", "Mise"], ["conf", "Gyóntatás"]]
    .map(([k, l]) => `<button type="button" data-kind="${k}" aria-pressed="${kind === k}">${l}</button>`).join("")}</div>
    <details class="ui-fold s-more" id="s-more"${S.moreOpen ? " open" : ""}><summary>További szűrők<span class="count">${esc(dayLabel(S.dayOffset))}${n ? ` · ${n} bekapcsolva` : ""}</span></summary>
    <div class="s-opts">
      <label class="s-opt"><span>Nap</span><select id="day">${opts}</select></label>
      <label class="s-opt"><span>Távolság innen</span><select id="origin">${ors}</select></label>
      ${TAG_OPTIONS.length ? `<label class="s-opt"><span>A mise jellege</span><select id="tagf"><option value="">Bármilyen mise</option>${TAG_OPTIONS.map(t => `<option value="${esc(t)}" ${S.f.tag === t ? "selected" : ""}>${tagLabel(t)}</option>`).join("")}</select></label>` : ""}
      ${isToday() ? tog("open", "Most nyitva") : ""}${tog("ev", "Esemény a héten")}${ctx.advent ? tog("rorate", "Rorate") : ""}
    </div></details>`;
}
const sFilters = $("#s-filters");
sFilters.addEventListener("click", e => {
  const b = e.target.closest("button[data-kind]"); if (!b) return;
  const k = b.dataset.kind; S.f.mass = k === "mass"; S.f.conf = k === "conf"; if (k) Track.ev("filter", k); render();
});
sFilters.addEventListener("toggle", e => { if (e.target.id === "s-more") S.moreOpen = e.target.open; }, true);
sFilters.addEventListener("change", e => {
  const t = e.target;
  if (t.dataset.f) { S.f[t.dataset.f] = t.checked; if (t.checked) Track.ev("filter", t.dataset.f); }
  else if (t.id === "day") { setDayOffset(+t.value); Track.ev("filter", "day"); }
  else if (t.id === "origin") {
    if (t.value === "__me") { closeSearch(); return locateMe(); }
    S.origin = t.value; try { localStorage.setItem("harangszo", JSON.stringify({ origin: S.origin })); } catch (_) { }
    Track.ev("filter", "origin");
  } else if (t.id === "tagf") { S.f.tag = t.value; if (t.value) Track.ev("filter", "tag"); }
  else return;
  render();
});
// The church list: nearest first, as many as LIST_LIMIT, with a summary line.
function listHTML(rows) {
  if (S.loading || S.error) return stateHTML();
  const ctx = dayContext(selDate()), shown = rows.slice(0, LIST_LIMIT), more = rows.length - shown.length;
  const feastNames = ctx.feasts.map(k => C.FEAST_BY_KEY[k].name).join(", ");
  let nConf = 0; for (const r of rows) if (r.di.hasConf) nConf++;
  return `<div class="lhead pad"><h2 class="sec-h">${S.q.trim() ? "Találatok" : "A közelben"}</h2>`
    + `<p class="summary">${rows.length.toLocaleString("hu-HU")} templom · ${nConf} helyen gyóntatnak ${isToday() ? "ma" : "aznap"} · ${ctx.summer ? "nyári" : "téli"} időszámítás · távolság: ${esc(S.origin)}</p>`
    + `${feastNames ? `<p class="feastline">Ünnep: ${esc(feastNames)}. Ahol a templom megadta, az ünnepi miserend látszik.</p>` : ""}</div>`
    + `<ul class="rows pad">${shown.map(listRowHTML).join("") || `<li class="ui-empty">Nincs a szűrőknek megfelelő templom. Próbálj másik napot, vagy kapcsolj ki egy szűrőt.</li>`}`
    + `${more > 0 ? `<li class="ui-empty">További ${more.toLocaleString("hu-HU")} templom. Írj be egy települést, vagy válassz másik kiindulópontot.</li>` : ""}</ul>`;
}
function renderSearch() {
  if (!S.search) return;
  renderFilters();
  $("#s-results").innerHTML = listHTML(lastRows);
}
$("#s-results").addEventListener("click", e => { const b = e.target.closest(".row[data-id]"); if (b) select(+b.dataset.id); });
let searchTimer, searchTrackTimer;
// Statistics: a search is counted once typing has stopped. A word that finds churches is part of their public
// name, town or address; a word that finds nothing is kept so the missing church or spelling can be added.
function trackSearch() {
  const raw = S.q.trim(), q = fold(raw);
  if (q.length < 3 || S.loading || !CHURCHES.length) return;
  Track.once(CHURCHES.some(c => c.key.includes(q)) ? "search" : "search_none", raw.toLowerCase().slice(0, 40));
}
$("#q").addEventListener("input", e => {
  S.q = e.target.value; clearTimeout(searchTimer);
  clearTimeout(searchTrackTimer); searchTrackTimer = setTimeout(trackSearch, 2000);
  searchTimer = setTimeout(render, 150);
});
$("#q").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });

/* ---------- Most: the nearest church with a Mass still to come ---------- */
function renderMost() {
  const today = now(), searchBtn = `<button class="pill" id="m-search" type="button" aria-haspopup="dialog">Keresés</button><span class="sp"></span>`;
  if (S.loading || S.error) {
    panel.innerHTML = `<div class="most">${plainTop(searchBtn)}<div class="m-body pad"><p class="dayline">${esc(dayLine(today))}</p>${stateHTML()}</div></div>`;
    return;
  }
  const { hero, next, any } = nearby(), c = hero?.r.c;
  const top = searchBtn + (c ? saveBtnHTML(c, "m-save") : "");
  let body = `<p class="dayline" id="m-day">${esc(dayLine(today))}</p>`;
  if (hero) {
    const web = webOf(c);
    body += whenHTML(c, hero.i, true, "m-when")
      + `<h2 class="cname" id="m-name">${esc(c.name)}</h2><p class="addr">${esc(whereOf(c))} · ${esc(distText(hero.r.dist))}</p>`
      + `<div class="acts"><a class="btn go" id="m-dir" href="${dirOf(c)}" target="_blank" rel="noopener noreferrer">Útvonal</a>`
      + `<button class="btn" type="button" id="m-week" data-open="${c.id}">Heti rend</button>`
      + `${web ? `<a class="btn" id="m-web" href="${esc(web)}" target="_blank" rel="noopener noreferrer">Honlap</a>` : ""}</div>`;
  } else {
    body += `<p class="m-empty" id="m-empty">${any ? "Ma már nincs több ismert szentmise a közelben. A templomok heti rendjét a Keresés vagy a Térkép alatt találod; holnapra a keresésben választhatsz napot."
      : "A közelben (25 km-en belül) nincs ismert templom. Keress települést, vagy válassz másik kiindulópontot a keresésben."}</p>`;
  }
  if (next.length) body += `<h3 class="sec">${hero ? "Utána a közelben" : "Ma még a közelben"}</h3><ul class="rows">${next.map(x =>
    rowHTML(x.r.c.id, showT(x.i.t), x.r.c.name, [timeWord(x.r.c, x.i), x.r.c.addr].filter(Boolean).join(" · "), kmText(x.r.dist))).join("")}</ul>`;
  const mine = S.origin === "Saját helyzetem";
  body += `<p class="m-origin">Kiindulópont: ${mine ? "a helyzeted" : esc(S.origin)}${navigator.geolocation && !mine ? ` · <button class="link" type="button" id="m-locate">Saját helyzetem</button>` : ""}</p>`;
  panel.innerHTML = `<div class="most" data-id="${c ? c.id : ""}">${hasPhoto(c) ? photoHTML(c, top) : plainTop(top)}<div class="m-body pad">${body}</div></div>`;
  fillPhotos(panel);
}
panel.addEventListener("click", e => {
  const sv = e.target.closest("[data-save]");
  if (sv) { const id = +sv.dataset.save, on = Saved.toggle(id); if (on) Track.once("save", id); panel.querySelectorAll(`[data-save="${id}"]`).forEach(b => setSaveBtn(b, on)); return; }
  if (e.target.closest("#m-search,[data-open-search]")) return openSearch(e.target.closest("button"));
  const wk = e.target.closest("#m-week"); if (wk) return select(+wk.dataset.open, { week: true });
  if (e.target.closest("#m-locate")) return locateMe();
  const a = e.target.closest("a#m-dir,a#m-web"); if (a) { Track.once(a.id === "m-dir" ? "dir" : "web", +panel.querySelector(".most").dataset.id); return; }
  const row = e.target.closest(".row[data-id]"); if (row) select(+row.dataset.id);
});

/* ---------- Mentett, and the list beside the map (desktop Térkép) ---------- */
function renderSaved() {
  if (S.loading || S.error) { panel.innerHTML = `<div class="lhead pad top-gap"><h2 class="sec-h">Mentett</h2></div>${stateHTML()}`; return; }
  const ctx = dayContext(selDate());
  const saved = Saved.ids().map(id => BY_ID.get(id)).filter(Boolean).map(c => ({ c, di: dayInfoCached(c, ctx), dist: distOf(c), os: null })).sort((a, b) => a.dist - b.dist);
  panel.innerHTML = `<div class="lhead pad top-gap"><h2 class="sec-h">Mentett</h2>${saved.length ? `<p class="summary">${saved.length} templom · távolság: ${esc(S.origin)}</p>` : ""}</div>`
    + (saved.length ? `<ul class="rows pad">${saved.map(listRowHTML).join("")}</ul>`
      : `<div class="ui-empty"><p>Még nincs mentett templom. A templom oldalán a szív gombbal mentheted, és itt mindig kéznél lesz.</p></div>`);
}
function renderMapList(rows) {
  panel.innerHTML = `<div class="pad top-gap"><button class="mapsearch in-col" type="button" data-open-search aria-haspopup="dialog">${svgI('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', 18)}<span>${esc(S.q.trim() || "Templom vagy település")}</span></button></div>` + listHTML(rows);
}

/* ---------- Térkép (phone): the bottom panel with the tapped or the next church ---------- */
function renderMapCard() {
  const el = $("#mapcard");
  if (S.loading || S.error) { el.innerHTML = `<p class="mc-msg">${S.error ? esc(S.error) : "Templomok betöltése…"}</p>`; return; }
  const { hero, next } = nearby();
  let c = null, i = null, dist = 0;
  if (S.pick && BY_ID.has(S.pick)) {
    c = BY_ID.get(S.pick); const di = dayInfoCached(c, dayContext(now()));
    i = upcomingOf(di, MASSK)[0] || upcomingOf(di, ALLK)[0] || null; dist = distOf(c);
  } else if (hero) { c = hero.r.c; i = hero.i; dist = hero.r.dist; }
  if (!c) { el.innerHTML = `<p class="mc-msg">Ma már nincs több ismert szentmise a közelben.</p>`; return; }
  const after = next.find(x => x.r.c.id !== c.id);
  el.innerHTML = `<button class="mc-main" type="button" data-id="${c.id}"><b class="mid">${i ? esc(showT(i.t)) : "–"}</b><span class="mc-t"><strong>${esc(c.name)}</strong>`
    + `<span>${i ? esc(kindName(c, i).toLowerCase()) : "ma már nincs"} · ${esc(distText(dist))}</span></span></button>`
    + (after ? `<button class="mc-row" type="button" data-id="${after.r.c.id}"><span><b>${esc(showT(after.i.t))}</b>${esc(after.r.c.name)}${after.r.c.addr ? " · " + esc(after.r.c.addr) : ""}</span><span class="r-d">${esc(kmText(after.r.dist))}</span></button>` : "");
}
$("#mapcard").addEventListener("click", e => { const b = e.target.closest("[data-id]"); if (b) select(+b.dataset.id); });
function locateMe() {
  if (!navigator.geolocation) return;
  toast("Helymeghatározás…");
  navigator.geolocation.getCurrentPosition(p => {
    ORIGINS["Saját helyzetem"] = [p.coords.latitude, p.coords.longitude]; S.origin = "Saját helyzetem"; Track.once("locate");
    MapView.focus(p.coords.latitude, p.coords.longitude, 13); MapView.me?.(p.coords.latitude, p.coords.longitude); toast(""); render();
  }, () => toast("A helyzeted nem érhető el. Engedélyezd a böngészőben, vagy válassz kiindulópontot a keresésben."), { timeout: 10000, maximumAge: 300000 });
}
$("#locate-btn").addEventListener("click", () => locateMe());

/* ---------- Rendering: detail ---------- */
const SEASON_NAME = Object.fromEntries(Object.entries(C.PERIOD_INFO).map(([k, v]) => [k, v.adj]));
const ORDW = { 1: "első", 2: "második", 3: "harmadik", 4: "negyedik", 5: "ötödik", "-1": "utolsó" };
const DAYW = ["vasárnapján", "hétfőjén", "keddjén", "szerdáján", "csütörtökén", "péntekjén", "szombatján"];
// "minden hónap utolsó szombatján" when a parish note does not already say it; "a hónap 4. vasárnapja kivételével" for most weeks.
const DAYW_EXC = ["vasárnapja", "hétfője", "keddje", "szerdája", "csütörtöke", "péntekje", "szombatja"];
function weeksText(w, dow) {
  const missing = [1, 2, 3, 4, 5].filter(n => !w.includes(n));
  if (!w.includes(-1) && w.length >= 3 && missing.length <= 2) return "a hónap " + missing.map(n => ORDW[n]).join(" és ") + " " + DAYW_EXC[dow] + " kivételével";
  return "a hónap " + w.map(n => ORDW[n]).join(" és ") + " " + DAYW[dow];
}
const EVERYW = { 2: "kéthetente", 3: "háromhetente", 4: "négyhetente" };
// "kéthetente, legközelebb nov. 8."
function everyText(s, dow) {
  if (!s.e) return "";
  const from = now(), next = C.nextDate(from, d => d.getDay() === dow && C.everyOk(d, s.e, s.a) && seasonOk(s, { date: d }));
  return (EVERYW[s.e] || s.e + " hetente") + (next ? ", legközelebb " + shortDate(next) : "");
}
const rangeText = v => v.split(",").map(r => r.split("/").map(x => { const [m, d] = x.split("-").map(Number); return `${MON[m - 1]} ${d}.`; }).join(" – ")).join(", ");
function weekTable(c, ctx) {
  const today = now().getDay();
  const reg = c.svc.filter(s => isRegular(s) && s.k !== "rorate" && seasonOk(s, ctx));
  const svcLabel = s => s.k === "prayer" ? `${showT(s.t)} ${s.n || "ájtatosság"}` : showT(s.t);
  const withHours = c.onlyServices || c.hours.length > 0;
  const item = (s, dow, label) => {
    const extra = [s.w ? weeksText(s.w, dow) : "", everyText(s, dow), s.skip ? "ünnepnapokon nincs" : "", s.k === "prayer" ? "" : s.n, whoWhere(s)].filter(Boolean).join(" · ");
    return `<span class="wt"><span class="t">${label}</span>${extra ? `<small>${esc(extra)}</small>` : ""}${tagsHTML(s.g)}</span>`;
  };
  const rows = [1, 2, 3, 4, 5, 6, 0].map(dow => {
    const ms = reg.filter(s => (s.k === "mass" || s.k === "prayer") && s.d.includes(dow)).sort((a, b) => mins(a.t) - mins(b.t)).map(s => item(s, dow, svcLabel(s))).join("");
    const cs = reg.filter(s => s.k === "conf" && s.d.includes(dow)).map(s => item(s, dow, "gyón. " + range(s.t, s.u))).join("");
    return `<tr class="${dow === today ? "today" : ""}"><th scope="row">${DAYN[dow].slice(0, 3)}.</th><td>${ms || cs ? ms + cs : "–"}</td>${withHours ? `<td class="hrs">${hoursText(c, dow)}</td>` : ""}</tr>`;
  }).join("");
  return `<thead><tr><th scope="col">Nap</th><th scope="col">${massWord(c) === "Szent Liturgia" ? "Liturgia" : "Szentmise"}${reg.some(s => s.k === "conf") ? " · gyónás" : ""}</th>${withHours ? `<th scope="col">Nyitva</th>` : ""}</tr></thead><tbody>${rows}</tbody>`;
}
// Which named seasons does this church use, which one applies now, and when does it change?
function seasonNote(c, ctx) {
  const groups = new Map();
  for (const s of c.svc) if (isRegular(s) && s.p !== "all" && s.k !== "rorate") groups.set(s.p + "|" + (s.v || ""), s);
  if (!groups.size) return "";
  const activeOn = d => [...groups.values()].filter(s => seasonOk(s, { date: d })).map(s => s.p).sort().join(",");
  const nowKey = activeOn(ctx.date);
  let change = null;
  for (let i = 1; i <= 366 && !change; i++) { const d = C.addDays(ctx.date, i); if (activeOn(d) !== nowKey) change = d; }
  const describe = s => s.v ? rangeText(s.v) : s.p === "summer" || s.p === "winter" ? "óraátállításhoz igazodva"
    : ["advent", "lent", "eastertide", "christmas"].includes(s.p) ? "az egyházi év szerint" : rangeText(C.PERIOD_INFO[s.p].range || "");
  const names = key => key.split(",").filter(Boolean).map(p => SEASON_NAME[p]).join(" és ") || "–";
  const active = [...groups.values()].filter(s => nowKey.split(",").includes(s.p));
  const list = [...new Map([...groups.values()].map(s => [s.p, s])).values()].map(s => `${SEASON_NAME[s.p]}: ${describe(s)}`).join(" · ");
  const az = w => /^[aáeéiíoóöőuúüű]/i.test(w) ? "az" : "a";
  return `<p class="muted season">${active.length ? `Most ${az(names(nowKey))} <b>${names(nowKey)}</b> miserend érvényes.` : ""}${change ? ` Következő váltás: ${change.getFullYear() !== ctx.date.getFullYear() ? change.getFullYear() + ". " : ""}${shortDate(change)} (${names(activeOn(change))} rend).` : ""}<br>${esc(list)}</p>`;
}
// The coming days (from today, a week ahead) that have times from the parish's own weekly schedule.
function datedDays(c) {
  const today = ymd(now()), until = ymd(C.addDays(now(), 7));
  return [...new Set((c.dated || []).map(d => d.date))].filter(d => d >= today && d < until).sort();
}
// Those days, day by day, with the source link.
function datedWeekHTML(c, days = datedDays(c)) {
  if (!days.length) return "";
  const today = ymd(now()), url = c.dated.find(d => d.url)?.url;
  const rows = days.map(day => {
    const dt = new Date(day + "T12:00"), list = c.dated.filter(d => d.date === day).sort((a, b) => mins(a.t) - mins(b.t));
    const ms = list.filter(i => i.k === "mass" || i.k === "rorate").map(i => showT(i.t)).join(" · ");
    const cs = list.filter(i => i.k === "conf").map(i => range(i.t, i.u)).join(" · ");
    const other = list.filter(i => i.k === "prayer" || i.k === "ador").map(i => `${showT(i.t)} ${i.n || (i.k === "ador" ? "szentségimádás" : "")}`).join(" · ");
    return `<tr class="${day === today ? "today" : ""}"><th scope="row">${DAYN[dt.getDay()].slice(0, 3)}.<small>${shortDate(dt)}</small></th><td><span class="wt"><span class="t">${ms || "–"}</span></span>${cs ? `<span class="wt"><small>gyónás: ${esc(cs)}</small></span>` : ""}${other ? `<span class="wt"><small>${esc(other)}</small></span>` : ""}</td></tr>`;
  }).join("");
  return `<div class="week"><table><thead><tr><th scope="col">Nap</th><th scope="col">Szentmise</th></tr></thead><tbody>${rows}</tbody></table></div>${url ? `<p class="muted source">Forrás: <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">a templom heti miserendje (PDF)</a></p>` : ""}`;
}
const rorateRules = c => c.svc.filter(s => isRegular(s) && s.k === "rorate").sort((a, b) => mins(a.t) - mins(b.t));
function rorateHTML(c, rr = rorateRules(c)) {
  if (!rr.length) return "";
  const y = now().getMonth() === 11 && now().getDate() > 24 ? now().getFullYear() + 1 : now().getFullYear();
  const s = C.adventStart(y);
  return `<h4 class="d-sub">Rorate · advent idején (${shortDate(s)} – dec. 24.)</h4><ul class="d-mini">${rr.map(r =>
    `<li><b class="t">${showT(r.t)}</b><span>${daysText(r.d)}${r.n ? `<small>${esc(r.n)}</small>` : ""}</span></li>`).join("")}</ul>`;
}
// Feasts in the next 120 days that have their own times here (or follow the Sunday order), one per date.
function feastList(c) {
  const keys = new Set([...c.feastSunday, ...c.svc.filter(s => s.feast).map(s => s.feast)]);
  if (!keys.size) return [];
  const from = now(), limit = C.addDays(from, 120), seen = new Set();
  return [...keys].map(k => ({ k, d: C.nextFeastDate(k, from) })).filter(x => x.d && x.d <= limit).sort((a, b) => a.d - b.d || C.isGroup(a.k) - C.isGroup(b.k))
    .filter(x => !seen.has(+x.d) && seen.add(+x.d)).map(x => C.isGroup(x.k) ? { k: C.feastsOn(x.d)[0], d: x.d } : x);
}
function feastScheduleHTML(c, list = feastList(c)) {
  if (!list.length) return "";
  return `<h4 class="d-sub">Ünnepi miserend</h4><div class="ev-list">${list.map(({ k, d }) => {
    const di = dayInfo(c, dayContext(d));
    const times = di.items.filter(i => i.k !== "ev").map(i => `${range(showT(i.t), i.end)} ${i.k === "mass" ? "mise" : i.k === "conf" ? "gyónás" : i.k === "ador" ? "szentségimádás" : i.k === "prayer" ? esc(i.what) : "rorate"}${i.n ? " (" + esc(i.n) + ")" : ""}`).join(" · ");
    return `<div class="ev"><div class="date"><b>${d.getDate()}</b><small>${MON[d.getMonth()]}</small></div><div><h5>${esc(C.FEAST_BY_KEY[k].name)}</h5>
      <div class="muted">${DAYN[d.getDay()]}${di.feastMode === "sunday" ? " · vasárnapi rend szerint" : ""}</div><div class="feast-times">${times || "–"}</div></div></div>`;
  }).join("")}</div>`;
}
const upcomingEvents = c => c.ev.filter(e => e.date >= ymd(now())).sort((a, b) => a.date.localeCompare(b.date));
function eventsHTML(list) {
  if (!list.length) return "";
  return `<div class="ev-list">${list.map(e => {
    const dt = new Date(e.date + "T12:00");
    return `<div class="ev"><div class="date"><b>${dt.getDate()}</b><small>${MON[dt.getMonth()]}</small></div><div><h5>${esc(e.title)}</h5><div class="muted">${DAYN[dt.getDay()]}${e.t ? ", " + e.t : ""}${e.n ? " · " + esc(e.n) : ""}</div></div></div>`;
  }).join("")}</div>`;
}
function noteHTML(c) {
  const lines = (c.note || "").split("\n").filter(Boolean);
  const src = c.parishUpdated ? `<p class="muted source">A plébánia adatai szerint · frissítve ${longDate(c.parishUpdated)}</p>` : c.source ? `<p class="muted source">Forrás: ${c.sourceUrl ? `<a href="${esc(c.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(SOURCES[c.source] || c.source)}</a>` : esc(SOURCES[c.source] || c.source)}${c.updated ? ` · frissítve ${longDate(c.updated)}` : ""}</p>` : "";
  if (!lines.length && !src) return "";
  // Lines ending in ":" are headings of the list that follows them.
  const body = lines.map(l => /:$/.test(l) ? `<p class="note-h">${linkify(l)}</p>` : `<p>${linkify(l)}</p>`).join("");
  return `${body ? `<div class="schednote">${body}</div>` : ""}${src}`;
}
let toastTimer;
function toast(msg) {
  const t = $("#toast"); if (!t) return;
  clearTimeout(toastTimer);
  if (!msg) { t.classList.remove("on"); return; }
  t.textContent = msg; t.classList.add("on");
  toastTimer = setTimeout(() => t.classList.remove("on"), 2400);
}
// Share sheet where the device has one; otherwise copy the church's link.
async function shareChurch(c) {
  Track.once("share", c.id);
  const url = location.origin + location.pathname + "#t=" + c.id;
  if (navigator.share) { try { await navigator.share({ title: c.name, url }); } catch (e) { } return; }
  let ok = false;
  try { await navigator.clipboard.writeText(url); ok = true; }
  catch (e) {
    const ta = document.createElement("textarea"); ta.value = url; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand("copy"); } catch (_) { }
    ta.remove();
  }
  toast(ok ? "Link másolva" : "A link másolása nem sikerült");
}
const noSchedule = c => !c.svc.length && !(c.dated || []).length;
const dayAt = off => { const d = now(); d.setDate(d.getDate() + off); return d; };
// Same effect as the day select in the search panel.
function setDayOffset(off) { S.dayOffset = off; if (!isToday()) S.f.open = false; if (!C.inAdvent(selDate())) S.f.rorate = false; }
const kindLabel = (c, k) => k === "mass" ? massWord(c) : k === "conf" ? "Gyóntatás" : k === "ador" ? "Szentségimádás" : k === "rorate" ? "Rorate" : k === "prayer" ? "Imaóra, ájtatosság" : "Esemény";
// The big time on a church page: the next Mass of the selected day (from now on, today), else its next time of any kind.
function nextHTML(c, di) {
  const m = nowMin();
  const up = di.items.filter(i => i.t && !i.away && (!isToday() || mins(i.end || i.t) >= m));
  const i = up.find(x => x.k === "mass" || x.k === "rorate") || up[0];
  if (!i) {
    if (noSchedule(c)) return `<div class="ui-empty d-empty" id="d-next"><p>Ehhez a templomhoz még nincs feltöltött időpont. Ha tudod a miserendet, küldd be a Javítás gombbal.</p></div>`;
    return `<p class="d-nomore" id="d-next">${isToday() ? "Ma már nincs több alkalom" : "Nincs alkalom ezen a napon"}</p>`;
  }
  return whenHTML(c, i, isToday(), "d-next");
}
// The selected day's times: feast line, then hairline rows (past times greyed).
function dayBoxHTML(c, di) {
  const m = nowMin();
  const feast = di.feastMode === "dated" ? `<p class="d-feast">A templom heti miserendje szerint${di.feast ? " · " + esc(di.feast) : ""}${di.datedUrl ? ` · <a href="${esc(di.datedUrl)}" target="_blank" rel="noopener noreferrer">forrás</a>` : ""}</p>`
    : di.feast ? `<p class="d-feast">Ünnepi miserend · ${esc(di.feast)}${di.feastMode === "sunday" ? " (vasárnapi rend szerint)" : ""}</p>` : "";
  const rows = di.items.map(i => {
    const past = isToday() && i.t && mins(i.end || i.t) < m;
    const main = i.k === "ev" || i.k === "prayer" ? i.what : i.k === "mass" ? kindName(c, i) : kindLabel(c, i.k);
    const sub = [i.end ? showT(i.end) + "-ig" : "", i.k === "prayer" ? "" : i.n, whoWhere(i)].filter(Boolean).join(" · ");
    return `<li class="d-row${past ? " past" : ""}"><span class="d-t">${showT(i.t) || "–"}</span><span class="d-k">${esc(main)}${sub ? `<small>${esc(sub)}</small>` : ""}${tagsHTML(i.g)}</span></li>`;
  }).join("") || `<li class="d-row d-none">Nincs meghirdetett alkalom ezen a napon.</li>`;
  return `<div class="d-daybox" id="d-daybox">${feast}<ul class="d-list" id="d-day" aria-label="${esc(dayLabel(S.dayOffset))}">${rows}</ul></div>`;
}
const foldHTML = (id, title, body, count) => body
  ? `<details class="ui-fold" id="${id}"><summary>${title}${count ? `<span class="count">${count}</span>` : ""}</summary><div class="d-fold">${body}</div></details>` : "";
function renderDetail() {
  const c = BY_ID.get(S.sel); if (!c) { S.sel = null; setView(); return renderMost(); }
  const ctx = dayContext(selDate()), di = dayInfoCached(c, ctx), os = openState(c, now());
  // The minute timer re-renders the page: keep open folds of the same church ("Heti rend" on Most opens the week).
  const prev = panel.querySelector(".detail"), same = prev && +prev.dataset.id === c.id;
  const openFolds = same ? [...prev.querySelectorAll(".ui-fold[open]")].map(f => f.id) : S.weekOpen ? ["f-week"] : [];
  const dir = dirOf(c), web = webOf(c);
  const acts = [`<a class="btn go d-act" href="${dir}" target="_blank" rel="noopener noreferrer">Útvonal</a>`,
    c.phone ? `<a class="btn d-act" href="tel:${esc(c.phone.replace(/[^\d+]/g, ""))}" aria-label="Hívás: ${esc(c.phone)}" title="${esc(c.phone)}">Hívás</a>` : "",
    web ? `<a class="btn d-act" href="${esc(web)}" target="_blank" rel="noopener noreferrer" title="${esc(c.web)}">Honlap</a>` : "",
    `<button class="btn d-act" type="button" id="go-suggest" aria-haspopup="dialog">Javítás</button>`].filter(Boolean);
  const showDays = !noSchedule(c) || c.ev.length > 0;
  const days = [...Array(7).keys()].map(i => `<button type="button" data-off="${i}" aria-pressed="${i === S.dayOffset}" aria-label="${esc(dayLabel(i))}"><span>${i === 0 ? "Ma" : DAY_SHORT[dayAt(i).getDay()]}</span><b>${dayAt(i).getDate()}</b></button>`).join("");
  // The week table lists Masses, prayers and confessions; its fold counts those rules.
  const reg = c.svc.filter(s => isRegular(s) && ["mass", "prayer", "conf"].includes(s.k) && seasonOk(s, ctx));
  const dDays = datedDays(c), feasts = feastList(c), rr = rorateRules(c), evs = upcomingEvents(c);
  const folds = [
    foldHTML("f-week", (c.dated || []).length ? "Általános heti rend" : "Heti rend", c.svc.some(s => !s.feast) || c.hours.length ? `<div class="week"><table>${weekTable(c, ctx)}</table></div>${seasonNote(c, ctx)}` : "", reg.length),
    foldHTML("f-dated", "A templom heti miserendje", datedWeekHTML(c, dDays), dDays.length),
    foldHTML("f-feasts", "Ünnepek és advent", feastScheduleHTML(c, feasts) + rorateHTML(c, rr), feasts.length + rr.length),
    foldHTML("f-events", "Események", eventsHTML(evs), evs.length),
    foldHTML("f-note", "Megjegyzés", noteHTML(c), 0),
  ].join("");
  const bar = `<button class="pill round" id="back" type="button" aria-label="Vissza" title="Vissza">${ICONS.back}</button><span class="sp"></span>`
    + `${saveBtnHTML(c, "save-church")}<button class="pill round" id="share" type="button" aria-label="Megosztás" title="Megosztás">${ICONS.share}</button>`;
  panel.innerHTML = `<div class="detail" data-id="${c.id}">${hasPhoto(c) ? photoHTML(c, bar, "d-bar") : plainTop(bar, "d-bar")}<div class="d-main pad">
    <p class="dayline" id="d-dayline">${esc(dayLine(selDate()))}</p>
    ${nextHTML(c, di)}
    <h2 class="d-name">${esc(c.name)}</h2>
    <p class="d-where">${esc(whereOf(c))} · ${esc(distText(distOf(c)))}</p>
    <p class="d-tags">${[os.label, riteName(c)].filter(Boolean).map(esc).join(" · ")}</p>
    ${c.approx ? `<p class="d-approx">A templom helye a térképen hozzávetőleges (a település közepe). Útvonaltervezés előtt ellenőrizd a címet.</p>` : ""}
    <div class="acts d-actions">${acts.join("")}</div>
    ${showDays ? `<div class="d-days" role="group" aria-label="Nap">${days}</div>${dayBoxHTML(c, di)}` : ""}
    ${folds ? `<div class="d-folds">${folds}</div>` : ""}
  </div></div>`;
  fillPhotos(panel);
  $("#back").addEventListener("click", back);
  // Statistics: taps on Útvonal / Hívás / Honlap.
  panel.querySelectorAll("a.d-act").forEach(a => a.addEventListener("click", () => Track.once(a.href.startsWith("tel:") ? "call" : a.href === dir ? "dir" : "web", c.id)));
  $("#share").addEventListener("click", () => shareChurch(c));
  $("#go-suggest").addEventListener("click", () => openSuggest(c));
  panel.querySelector(".d-days")?.addEventListener("click", e => {
    const b = e.target.closest("button[data-off]"); if (!b) return;
    setDayOffset(+b.dataset.off);
    panel.querySelectorAll(".d-days button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    const d2 = dayInfoCached(c, dayContext(selDate()));
    $("#d-dayline").textContent = dayLine(selDate());
    $("#d-next").outerHTML = nextHTML(c, d2);
    $("#d-daybox").outerHTML = dayBoxHTML(c, d2);
    drawMarkers(filtered()); renderSearch();
  });
  for (const id of openFolds) document.getElementById(id)?.setAttribute("open", "");
}

/* ---------- Suggestions: database when live, otherwise a pre-filled GitHub issue ---------- */
const TYPES = { conf: "Gyóntatási időpont", mass: "Mise időpont", hours: "Nyitvatartás", event: "Esemény", place: "Hely vagy egyéb" };
function suggestForm(c) {
  return `<p class="s-church">${esc(c.name)}</p><form class="suggest" id="s-form" novalidate>
    <label class="ui-field" for="s-type"><span>Mit javítanál?</span><select id="s-type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
    <label class="ui-field" for="s-text"><span>Leírás</span><textarea id="s-text" maxlength="600" rows="4" placeholder="Pl. Szerdánként 17:00–18:00 között is gyóntatnak, a hirdetőtábla szerint."></textarea></label>
    ${LIVE ? `<label class="ui-field" for="s-contact"><span>E-mail vagy telefon (nem kötelező, csak ha visszakérdeznénk)</span><input id="s-contact" type="text" maxlength="200" autocomplete="email"></label>` : ""}
    <p class="s-legal">A beküldéssel hozzájárulsz, hogy a javaslatot és a megadott elérhetőséget az <a href="jogi.html#adatkezeles" target="_blank" rel="noopener">adatkezelési tájékoztató</a> szerint kezeljük.</p>
    <div class="s-send"><button class="ui-btn primary" type="submit" id="s-send">Javaslat beküldése</button><span class="status" id="s-status" role="status"></span></div>
    <p class="muted">${LIVE ? "A javaslatot egy szerkesztő ellenőrzi, mielőtt megjelenik." : "A beküldés egy GitHub-hibajegyet nyit meg kitöltve (GitHub-fiók kell hozzá)."}</p>
  </form>`;
}
// "Javítás": the suggestion form in a sheet, filled when it opens (so the minute re-render never wipes a draft).
const suggestEl = $("#suggest");
function openSuggest(c) { $("#suggest-body").innerHTML = suggestForm(c); bindSuggest(c); if (!suggestEl.open) suggestEl.showModal(); }
$("#suggest-done").addEventListener("click", () => suggestEl.close());
suggestEl.addEventListener("click", e => { if (e.target === suggestEl) suggestEl.close(); }); // tap on the backdrop
function bindSuggest(c) {
  const st = $("#s-status");
  $("#s-form").addEventListener("submit", async e => {
    e.preventDefault();
    const text = $("#s-text").value.trim(), type = $("#s-type").value;
    if (text.length < 5) { st.textContent = "Írj legalább pár szót arról, mi változott."; st.className = "status err"; return; }
    if (!LIVE) {
      const title = `[${TYPES[type]}] ${c.name} (${c.city})`;
      const body = `**Templom:** ${c.name}, ${c.city}, ${c.addr} (id: ${c.id})\n**Típus:** ${TYPES[type]}\n\n${text}`;
      window.open(`https://github.com/${REPO}/issues/new?labels=javaslat&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`, "_blank", "noopener");
      st.textContent = "Megnyitottuk a beküldő oldalt egy új lapon."; st.className = "status ok"; return;
    }
    $("#s-send").disabled = true; st.textContent = "Küldés…"; st.className = "status";
    try {
      const contact = ($("#s-contact")?.value || "").trim() || null;
      const res = await fetch(`${SB_URL}/rest/v1/suggestions`, { method: "POST",
        headers: { ...SB_HEADERS, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ church_id: c.id, type, text, contact }) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      $("#s-text").value = ""; if ($("#s-contact")) $("#s-contact").value = "";
      st.textContent = "Köszönjük! A javaslat ellenőrzésre vár."; st.className = "status ok"; Track.ev("suggest", c.id);
    } catch (err) {
      st.textContent = "Nem sikerült elküldeni. Ellenőrizd az internetkapcsolatot, és próbáld újra."; st.className = "status err";
    } finally { $("#s-send").disabled = false; }
  });
}

/* ---------- Installable app: offline note, new version, install ---------- */
// "Nincs internet · a lista működik" while the device is offline or the map library could not load.
const Offline = (() => {
  const note = $("#offnote"); let failed = false, retry = null;
  const show = () => { note.hidden = navigator.onLine && !failed; };
  window.addEventListener("offline", show);
  window.addEventListener("online", () => { if (retry) { const r = retry; retry = null; failed = false; r(); } show(); });
  show();
  // reload: how to try loading the map again once back online (Google Maps); without it the note stays.
  return { mapFailed(reload) { failed = true; retry = reload || null; show(); } };
})();
const NO_DATA = "Nincs internetkapcsolat, és még nincs elmentett templomlista ezen az eszközön. Csatlakozz az internethez, és frissítsd az oldalt.";

// Service worker (sw.js): not on a local server unless ?sw=1, so development always sees fresh files.
(function serviceWorker() {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (!("serviceWorker" in navigator) || (local && !/[?&]sw=1(&|$)/.test(location.search))) return;
  const el = $("#update"); let reloading = false;
  const offer = worker => {
    el.classList.add("on");
    $("#update-btn").onclick = () => { reloading = true; el.classList.remove("on"); worker.postMessage("skipWaiting"); };
  };
  $("#update-x").addEventListener("click", () => el.classList.remove("on"));
  // Only reload when the visitor asked for the new version (the very first install also changes the controller).
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (reloading) location.reload(); });
  navigator.serviceWorker.register("sw.js", { scope: "./" }).then(reg => {
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const w = reg.installing; if (!w) return;
      w.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) offer(w); });
    });
    // An installed app can stay open for days: look for a new version whenever it comes back to the front.
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => { }); });
  }).catch(() => { }); // without a service worker the site still works as a normal page
})();

// "Telepítés a kezdőképernyőre": the browser's own prompt (Android, Chrome), or the steps on an iPhone.
(function install() {
  const btn = $("#install-btn"), sheet = $("#install");
  const standalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const ios = (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) && navigator.standalone === false;
  let prompt = null;
  const update = () => { btn.hidden = standalone() || !(prompt || ios); };
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); prompt = e; update(); });
  window.addEventListener("appinstalled", () => { prompt = null; update(); Track.once("install"); });
  btn.addEventListener("click", async () => {
    if (prompt) { const p = prompt; prompt = null; try { await p.prompt(); await p.userChoice; } catch (_) { } update(); return; }
    if (ios && !sheet.open) sheet.showModal();
  });
  $("#install-done").addEventListener("click", () => sheet.close());
  sheet.addEventListener("click", e => { if (e.target === sheet) sheet.close(); }); // tap on the backdrop
  update();
})();

/* ---------- Map ---------- */
/* The map never draws every church one by one. Below street level, churches that are close together on screen
   are merged into one black circle with their number ("37"); tapping it zooms in on them. A church that stands
   alone keeps its own marker: a dot when zoomed out, a black time label when zoomed in (the next one red, a church
   with nothing more that day a small grey dot). From SHOW_ALL_ZOOM on, every church has its own marker. */
const HU_BOUNDS = { s: 45.7, w: 16.1, n: 48.6, e: 22.9 };
// How far the map may pan. Wider than Hungary on purpose: if the screen shows more than this, the map is pinned
// to its middle and cannot shift Hungary out from under the side column.
const PAN_BOUNDS = { s: 43.5, w: 11.5, n: 50.5, e: 27.5 };
const SHOW_ALL_ZOOM = 14, LABEL_ZOOM = 12.5, CLUSTER_PX = 72;
// Web Mercator world pixels at a zoom level (both map libraries use 256px tiles).
const worldPx = (lat, lon, z) => { const k = 256 * 2 ** z, sn = Math.sin(lat * Math.PI / 180);
  return [(lon + 180) / 360 * k, (0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * k]; };
const clusterSize = n => n < 10 ? 30 : n < 100 ? 36 : n < 1000 ? 42 : 50;
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const FONT = "-apple-system,'SF Pro Text',Roboto,system-ui,sans-serif";
// Room the floating UI takes on each side of the map, so the first view of Hungary is not hidden under the search
// field and the bottom panel (phone) or the zoom buttons (desktop; the column sits beside the map, not over it).
function fitPadding() {
  const W = innerWidth, H = innerHeight, ctrls = $(".ctrls");
  if (isDesktop()) return { top: 24, bottom: 24, left: 24, right: Math.max(0, W - ctrls.getBoundingClientRect().left) + 24 };
  return { top: $("#map-search").getBoundingClientRect().bottom + 8, bottom: Math.max(0, H - $("#mapcard").getBoundingClientRect().top) + 8, left: 8, right: 8 };
}
const OSM_DATA_CREDIT = 'Templomhelyek: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

// Church markers are created once per church on first show; each draw only adds/removes the ones whose visibility
// changed and re-styles the ones whose look changed. Cluster markers are thrown away once hidden.
function makeDiffer(create, restyle, addMany, removeMany) {
  const cache = new Map(); let shown = new Set();
  return list => {
    const next = new Set(), toAdd = [];
    for (const p of list) {
      let e = cache.get(p.key);
      if (!e) { e = { mk: create(p), sig: "", temp: !!p.n }; cache.set(p.key, e); }
      const sig = p.cls + "|" + (p.label || "") + (p.dot ? "." : "") + (p.sel ? "*" : "") + (p.next ? "!" : "") + (p.n || "");
      if (e.sig !== sig) { restyle(e.mk, p); e.sig = sig; }
      next.add(p.key);
      if (!shown.has(p.key)) toAdd.push(e.mk);
    }
    const toRemove = [];
    for (const k of shown) if (!next.has(k)) { const e = cache.get(k); toRemove.push(e.mk); if (e.temp) cache.delete(k); }
    if (toRemove.length) removeMany(toRemove);
    if (toAdd.length) addMany(toAdd);
    shown = next;
  };
}
// Tapping a number zooms in until its churches spread out; tapping a church shows it in the bottom panel (phone)
// or opens its page in the column (desktop).
const openCluster = p => MapView.zoomTo(p.b);
function tapChurch(id) {
  if (isDesktop() || S.sel || S.tab !== "map") return select(id);
  S.pick = id; renderMapCard(); queueMarkers();
}
const zIndexOf = p => p.sel ? 1000 : p.next ? 900 : p.n ? 500 + Math.min(p.n, 400) : Math.round(p.c.score) + (p.cls === "none" ? 0 : 200);
const mkClass = p => p.next ? "next" : p.cls === "none" ? "none" : "on";
function leafletView() {
  const map = L.map("map", { minZoom: 6, maxZoom: 18, zoomSnap: .25, zoomControl: false, maxBounds: [[PAN_BOUNDS.s, PAN_BOUNDS.w], [PAN_BOUNDS.n, PAN_BOUNDS.e]] });
  // CARTO's base map (OpenStreetMap data), turned fully grey in styles.css.
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const tiles = () => L.tileLayer(`https://{s}.basemaps.cartocdn.com/${dark.matches ? "dark_all" : "rastertiles/voyager"}/{z}/{x}/{y}{r}.png`, { maxZoom: 19, subdomains: "abcd",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-közreműködők &copy; <a href="https://carto.com/attributions">CARTO</a>' });
  let base = tiles().addTo(map);
  dark.addEventListener?.("change", () => { map.removeLayer(base); base = tiles().addTo(map); });
  $("#zoom-in").addEventListener("click", () => map.zoomIn()); $("#zoom-out").addEventListener("click", () => map.zoomOut());
  let meMk = null;
  { const p = fitPadding(); map.fitBounds([[HU_BOUNDS.s, HU_BOUNDS.w], [HU_BOUNDS.n, HU_BOUNDS.e]], { paddingTopLeft: [p.left, p.top], paddingBottomRight: [p.right, p.bottom] }); }
  const layer = L.layerGroup().addTo(map);
  const icons = {};
  const icon = p => { const k = mkClass(p) + p.label + p.dot + p.sel + (p.n || ""); return icons[k] || (icons[k] = L.divIcon({ className: "mkicon", iconSize: [0, 0],
    html: p.n ? `<div class="mkclu" style="--s:${clusterSize(p.n)}px" aria-label="${p.n} templom">${p.n.toLocaleString("hu-HU")}</div>`
      : p.dot ? `<div class="mkdot mk-${mkClass(p)}${p.sel ? " sel" : ""}"></div>` : `<div class="mkwrap"><span class="mk mk-${mkClass(p)}${p.sel ? " sel" : ""}">${esc(p.label)}</span></div>` })); };
  const draw = makeDiffer(
    p => { const mk = L.marker([p.lat, p.lon], { title: p.n ? `${p.n} templom – nagyíts rá` : p.c.name, icon: icon({ cls: "none", label: "–", dot: true, sel: false }), keyboard: false });
      mk.on("click", () => p.n ? openCluster(p) : tapChurch(p.c.id)); return mk; },
    (mk, p) => { mk.setIcon(icon(p)); mk.setZIndexOffset(zIndexOf(p)); },
    arr => arr.forEach(m => layer.addLayer(m)),
    arr => arr.forEach(m => layer.removeLayer(m)));
  let resizeT; window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { map.invalidateSize(); queueMarkers(); }, 150); });
  map.on("moveend", () => queueMarkers());
  return {
    draw, ready: () => true,
    view() { const b = map.getBounds().pad(0.05); return { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast(), zoom: map.getZoom() }; },
    focus(lat, lon, z) { map.flyTo([lat, lon], Math.max(map.getZoom(), z), { duration: motionOk() ? .5 : 0 }); },
    zoomTo(b) { const z = map.getZoom(), t = Math.min(map.getBoundsZoom([[b.s, b.w], [b.n, b.e]], false, L.point(60, 60)), 17);
      map.flyTo([(b.s + b.n) / 2, (b.w + b.e) / 2], Math.max(t, z + 1.5), { duration: motionOk() ? .5 : 0 }); },
    me(lat, lon) { if (meMk) meMk.setLatLng([lat, lon]); else meMk = L.marker([lat, lon], { icon: L.divIcon({ className: "mkicon", iconSize: [0, 0], html: '<div class="me-dot"></div>' }), interactive: false, zIndexOffset: 2000 }).addTo(map); }
  };
}
// Google Maps in the same grey as the Leaflet map, no Google buttons, the same black labels as markers.
const GM_LIGHT = [{ stylers: [{ saturation: -100 }] }, { featureType: "poi", stylers: [{ visibility: "off" }] }, { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "landscape", elementType: "geometry", stylers: [{ lightness: 45 }] }, { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
  { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] }, { featureType: "water", elementType: "geometry", stylers: [{ color: "#dcdcdc" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#6b6b6b" }] }];
const GM_DARK = [{ stylers: [{ saturation: -100 }] }, { featureType: "poi", stylers: [{ visibility: "off" }] }, { featureType: "transit", stylers: [{ visibility: "off" }] },
  { elementType: "geometry", stylers: [{ color: "#1a1a1a" }] }, { elementType: "labels.text.fill", stylers: [{ color: "#8c8c8c" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#0e0e0e" }] }, { featureType: "road", elementType: "geometry", stylers: [{ color: "#2c2c2c" }] },
  { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] }, { featureType: "water", elementType: "geometry", stylers: [{ color: "#0b0b0b" }] },
  { featureType: "administrative", elementType: "geometry.stroke", stylers: [{ color: "#3a3a3a" }] }];
const svgUrl = s => "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(s);
const xmlEsc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
// A label with a small pointer under it; the pointer's tip is the church.
const pinSVG = (fill, ink, label, sel) => {
  const w = Math.round(14 + label.length * 7.2), h = 24, W = w + 4, H = h + 8;
  return { url: svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <path d="M2 ${2 + 6}a6 6 0 0 1 6-6h${w - 12}a6 6 0 0 1 6 6v${h - 12}a6 6 0 0 1-6 6h-${w / 2 - 11}l-5 5-5-5h-${w / 2 - 11}a6 6 0 0 1-6-6z" fill="${fill}" stroke="${sel ? ink : fill}" stroke-width="${sel ? 2 : 1}"/>
    <text x="${W / 2}" y="${2 + h / 2 + 4.5}" text-anchor="middle" font-family="${FONT}" font-size="13" font-weight="600" fill="${ink}">${xmlEsc(label)}</text></svg>`), w: W, h: H };
};
const cluSVG = (fill, ink, ring, label, d) => svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}" viewBox="0 0 ${d} ${d}">
  <circle cx="${d / 2}" cy="${d / 2}" r="${d / 2 - 1.5}" fill="${fill}" stroke="${ring}" stroke-width="1.5"/>
  <text x="${d / 2}" y="${d / 2 + 4.5}" text-anchor="middle" font-family="${FONT}" font-size="13" font-weight="600" fill="${ink}">${label}</text></svg>`);
const dotSVG = (fill, ring, r) => svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="${r}" fill="${fill}" stroke="${ring}" stroke-width="2"/></svg>`);
function googleView() {
  let gmap = null, pendingFocus = null, draw = null, meMk = null, moved = false;
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const pal = () => ({ ink: css("--ink"), bg: css("--bg"), red: css("--red"), grey: css("--ink-3") });
  let colors = null, iconCache = {};
  const icon = p => {
    const cls = mkClass(p), k = cls + p.label + p.dot + p.sel + (p.n || ""); if (iconCache[k]) return iconCache[k];
    if (p.n) { const d = clusterSize(p.n); return iconCache[k] = { url: cluSVG(colors.ink, colors.bg, colors.bg, p.n.toLocaleString("hu-HU"), d), scaledSize: new google.maps.Size(d, d), anchor: new google.maps.Point(d / 2, d / 2) }; }
    const fill = cls === "next" ? colors.red : cls === "none" ? colors.grey : colors.ink;
    if (p.dot || cls === "none") return iconCache[k] = { url: dotSVG(fill, colors.bg, cls === "none" ? 4.5 : p.sel ? 7 : 6), scaledSize: new google.maps.Size(20, 20), anchor: new google.maps.Point(10, 10) };
    const sv = pinSVG(fill, colors.bg, p.label, p.sel);
    return iconCache[k] = { url: sv.url, scaledSize: new google.maps.Size(sv.w, sv.h), anchor: new google.maps.Point(sv.w / 2, sv.h - 1) };
  };
  window.__initGoogle = () => {
    colors = pal();
    gmap = new google.maps.Map(document.getElementById("map"), { center: { lat: 47.16, lng: 19.5 }, zoom: 7, isFractionalZoomEnabled: true, disableDefaultUI: true, keyboardShortcuts: false,
      gestureHandling: "greedy", clickableIcons: false, backgroundColor: css("--land"), styles: dark.matches ? GM_DARK : GM_LIGHT,
      restriction: { latLngBounds: { north: PAN_BOUNDS.n, south: PAN_BOUNDS.s, west: PAN_BOUNDS.w, east: PAN_BOUNDS.e } } });
    // Fit twice: on the first call the map has no size yet and its pan limit keeps it centred; once it has
    // drawn, the padding can shift Hungary out from under the search field and the bottom panel.
    const fitHU = () => gmap.fitBounds({ north: HU_BOUNDS.n, south: HU_BOUNDS.s, west: HU_BOUNDS.w, east: HU_BOUNDS.e }, fitPadding());
    fitHU(); google.maps.event.addListenerOnce(gmap, "idle", () => { if (!pendingFocus && !moved) fitHU(); });
    dark.addEventListener?.("change", () => { gmap.setOptions({ styles: dark.matches ? GM_DARK : GM_LIGHT }); colors = pal(); iconCache = {}; queueMarkers(); });
    draw = makeDiffer(
      p => { const mk = new google.maps.Marker({ position: { lat: p.lat, lng: p.lon }, title: p.n ? `${p.n} templom – nagyíts rá` : p.c.name, optimized: true });
        mk.addListener("click", () => p.n ? openCluster(p) : tapChurch(p.c.id)); return mk; },
      (mk, p) => { mk.setIcon(icon(p)); mk.setZIndex(zIndexOf(p)); },
      arr => arr.forEach(m => m.setMap(gmap)),
      arr => arr.forEach(m => m.setMap(null)));
    gmap.addListener("idle", () => queueMarkers());
    if (pendingFocus) api.focus(...pendingFocus);
  };
  $("#zoom-in").addEventListener("click", () => gmap && gmap.setZoom(gmap.getZoom() + 1)); $("#zoom-out").addEventListener("click", () => gmap && gmap.setZoom(gmap.getZoom() - 1));
  window.gm_authFailure = () => { Track.once("error", "map"); $("#notice").innerHTML = "<b>Térképhiba.</b> A Google Maps kulcs nem érvényes ehhez a címhez. Ellenőrizd a kulcs webhely-korlátozását."; };
  const load = () => {
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(MAPS_KEY)}&callback=__initGoogle&language=hu&region=HU&loading=async`;
    s.async = true; s.onerror = () => { s.remove(); Offline.mapFailed(load); }; document.head.appendChild(s);
  };
  load();
  const api = {
    draw: list => draw && draw(list), ready: () => !!(draw && gmap.getBounds()),
    view() { const b = gmap.getBounds(), ne = b.getNorthEast(), sw = b.getSouthWest(), dy = (ne.lat() - sw.lat()) * .05, dx = (ne.lng() - sw.lng()) * .05;
      return { s: sw.lat() - dy, w: sw.lng() - dx, n: ne.lat() + dy, e: ne.lng() + dx, zoom: gmap.getZoom() }; },
    focus(lat, lon, z) { moved = true; if (!gmap) { pendingFocus = [lat, lon, z]; return; } gmap.panTo({ lat, lng: lon }); if (gmap.getZoom() < z) gmap.setZoom(z); },
    zoomTo(b) { if (!gmap) return; moved = true; const z = gmap.getZoom();
      if (b.n - b.s < 1e-4 && b.e - b.w < 1e-4) { gmap.panTo({ lat: b.s, lng: b.w }); gmap.setZoom(Math.max(z + 2, SHOW_ALL_ZOOM)); return; }
      gmap.fitBounds({ north: b.n, south: b.s, east: b.e, west: b.w }, 60);
      google.maps.event.addListenerOnce(gmap, "idle", () => { if (gmap.getZoom() <= z) gmap.setZoom(z + 1); else if (gmap.getZoom() > 17) gmap.setZoom(17); }); },
    me(lat, lon) { if (!gmap) return; const pos = { lat, lng: lon }; if (meMk) meMk.setPosition(pos); else meMk = new google.maps.Marker({ position: pos, map: gmap, clickable: false, zIndex: 2000,
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: "#1a73e8", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 3 } }); }
  };
  return api;
}
const MapView = MAPS_KEY ? googleView() : (typeof L !== "undefined" ? leafletView() : { draw() { }, ready: () => false, view() { }, focus() { }, zoomTo() { } });
if (!MAPS_KEY && typeof L === "undefined") Offline.mapFailed();

let mapRows = [], markerJob = null;
function drawMarkers(rows) { mapRows = rows; queueMarkers(); }
// Deferred so the column paints first; only the latest request runs.
function queueMarkers() {
  if (markerJob) (window.cancelIdleCallback || clearTimeout)(markerJob);
  markerJob = window.requestIdleCallback ? requestIdleCallback(updateMarkers, { timeout: 250 }) : setTimeout(updateMarkers, 50);
}
// The selected church's label also names it: "18:00 Mátyás-templom".
const shortName = n => n.length > 22 ? n.slice(0, 21).trimEnd() + "…" : n;
function updateMarkers() {
  markerJob = null;
  if (!MapView.ready()) return;
  const v = MapView.view(), inView = [], selId = S.sel || S.pick, nid = isToday() ? nextId() : null;
  for (const r of mapRows) { const c = r.c; if (c.lat >= v.s && c.lat <= v.n && c.lon >= v.w && c.lon <= v.e) inView.push(r); }
  const dot = v.zoom < LABEL_ZOOM;
  // The next church (the one Most shows) is labelled with that Mass: "18:00 Mátyás-templom", in red.
  const hero = nid ? nearby().hero : null;
  const one = (r, sel) => { const isNext = r.c.id === nid, n = isNext ? { t: showT(hero.i.t), k: hero.i.k, cls: "mass" } : nextOf(r.di);
    return { key: r.c.id, c: r.c, lat: r.c.lat, lon: r.c.lon, cls: n.cls, label: (sel || isNext) && n.k ? n.t + " " + shortName(r.c.name) : n.t, dot: dot && !sel && !isNext, sel, next: isNext && !!n.k }; };
  const list = [];
  if (v.zoom >= SHOW_ALL_ZOOM) for (const r of inView) list.push(one(r, selId === r.c.id));
  else {
    // Grid clustering in screen pixels: churches in the same CLUSTER_PX cell become one numbered marker.
    // The selected and the next church always keep their own marker.
    const cells = new Map(), z = v.zoom;
    for (const r of inView) {
      if (selId === r.c.id || nid === r.c.id) { list.push(one(r, selId === r.c.id)); continue; }
      const [x, y] = worldPx(r.c.lat, r.c.lon, z), k = Math.floor(x / CLUSTER_PX) + ":" + Math.floor(y / CLUSTER_PX);
      const g = cells.get(k); if (g) g.push(r); else cells.set(k, [r]);
    }
    // Neighbouring cells can put two markers on top of each other; merge any pair whose circles would touch
    // (biggest first, so small groups fold into big ones).
    const groups = [...cells].map(([k, g]) => { const [x, y] = worldPx(g.reduce((a, r) => a + r.c.lat, 0) / g.length, g.reduce((a, r) => a + r.c.lon, 0) / g.length, z); return { k, g, x, y }; })
      .sort((a, b) => b.g.length - a.g.length), kept = [];
    for (const q of groups) {
      const t = kept.find(o => Math.hypot(o.x - q.x, o.y - q.y) < (clusterSize(o.g.length) + clusterSize(q.g.length)) / 2 + 16);
      if (!t) { kept.push(q); continue; }
      const n = t.g.length + q.g.length; t.x = (t.x * t.g.length + q.x * q.g.length) / n; t.y = (t.y * t.g.length + q.y * q.g.length) / n; t.g = t.g.concat(q.g);
    }
    for (const { k, g } of kept) {
      if (g.length === 1) { list.push(one(g[0], false)); continue; }
      let la = 0, lo = 0, s = 90, w = 180, n = -90, e = -180;
      for (const r of g) { const c = r.c; la += c.lat; lo += c.lon; s = Math.min(s, c.lat); n = Math.max(n, c.lat); w = Math.min(w, c.lon); e = Math.max(e, c.lon); }
      list.push({ key: `g${z}:${k}`, n: g.length, lat: la / g.length, lon: lo / g.length, b: { s, w, n, e }, cls: "on", label: "", dot: false, sel: false, next: false });
    }
  }
  if (selId && !list.some(p => p.sel)) { const c = BY_ID.get(selId); if (c) list.push(one({ c, di: dayInfoCached(c, dayContext(selDate())) }, true)); }
  MapView.draw(list);
}

/* ---------- Boot ---------- */
// The column remembers where each list was scrolled; a church page opens at its top.
let lastKey = null; const scrollMem = {};
function render() {
  setView();
  const key = S.sel ? "c" + S.sel : S.tab, top = col.scrollTop;
  const rows = S.loading || S.error ? [] : filtered();
  if (S.sel) renderDetail(); else if (S.tab === "saved") renderSaved(); else if (S.tab === "map") renderMapList(rows); else renderMost();
  renderMapCard(); renderSearch();
  $("#map-search-text").textContent = S.q.trim() || "Templom vagy település";
  drawMarkers(rows);
  if (key !== lastKey) { if (lastKey) scrollMem[lastKey] = top; col.scrollTop = S.sel ? 0 : scrollMem[key] || 0; lastKey = key; }
  else col.scrollTop = top;
}
$("#notice").innerHTML = LIVE
  ? `<b>Fejlesztés alatt.</b> Az időpontokat a plébániák és a hívek töltik fel, így sok templomnál még hiányoznak. Indulás előtt ellenőrizd a plébánián. ${OSM_DATA_CREDIT}.`
  : `<b>Bemutató.</b> A templomok valósak, de a mise-, gyóntatási és nyitvatartási időpontok kitalált mintaadatok. Indulás előtt mindig ellenőrizd a plébánián.`;
// The bottom panel's height, for the toasts and the offline note above it on the map.
(function measure() {
  const set = () => app.style.setProperty("--mapcard-h", Math.round($("#mapcard").offsetHeight) + "px");
  set(); if (window.ResizeObserver) new ResizeObserver(set).observe($("#mapcard"));
})();
const typing = () => document.activeElement?.matches("input,textarea,select");
function boot() {
  if (!LIVE) { setChurches(SAMPLE_CHURCHES.map(fromSample)); S.loading = false; render(); return; }
  const cached = readCache();
  if (cached) { try { setChurches(JSON.parse(cached).map(fromDb)); S.loading = false; } catch (e) { } }
  render();
  // Refresh in the background; only re-render if something actually changed.
  fetchLive().then(text => {
    if (text === cached) return;
    setChurches(JSON.parse(text).map(fromDb)); writeCache(text);
    S.loading = false; S.error = "";
    if (!typing()) render();
    openDeepLink();
  }).catch(e => {
    if (!S.loading) return; // the cached list stays
    S.loading = false;
    // No connection (fetch's TypeError) and nothing saved on this device yet: say so instead of a server error.
    S.error = e instanceof TypeError || !navigator.onLine ? NO_DATA : "Nem sikerült betölteni a templomokat. Frissítsd az oldalt egy kicsit később.";
    if (S.error !== NO_DATA) Track.once("error", "data");
    render();
  });
}
// A link like ./#t=123 (e.g. from the parish page) opens that church once the data is there.
let deepLink = +((location.hash.match(/t=(\d+)/) || [])[1] || 0);
const openDeepLink = () => { if (deepLink && BY_ID.has(deepLink)) { const id = deepLink; deepLink = 0; select(id); } };
render(); boot(); openDeepLink();
setInterval(() => { if (!S.loading && !typing()) render(); }, 60000);
