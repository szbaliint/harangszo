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
    web: c.web, phone: c.phone, note: c.note || "", approx: !!c.approx };
}
function fromDb(c) {
  return { id: c.id, name: c.name, city: c.city || "", addr: c.address || "", rite: c.rite, lat: c.lat, lon: c.lon,
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
  dayCache.clear(); distCache.origin = null;
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
const S = { q: "", dayOffset: 0, origin: "Budapest", f: { open: false, mass: false, conf: false, ev: false, rorate: false, tag: "" }, sel: null, loading: true, error: "", tab: "map", sheet: window.matchMedia("(min-width:900px)").matches ? "full" : "closed" };
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

/* ---------- Sheet, tabs, Legközelebb card ---------- */
const sheetEl = $("#sheet"), isDesktop = () => window.matchMedia("(min-width:900px)").matches;
function setSheet(state) {
  if (isDesktop() && state === "peek") state = "full";
  S.sheet = state; sheetEl.dataset.state = state;
  document.querySelectorAll(".ui-tab").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tab === (state === "closed" ? "map" : S.tab))));
}
/* Motion: the panel's content changes through a view transition (styles.css "Motion"); the map and the sheet's own
   slide never take part. kind: "open" (a church), "back" (to the list), "tab" (crossfade). Reduced motion: no animation. */
const motionOk = () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let vtSeq = 0;
function withTransition(update, kind = "tab") {
  if (!motionOk()) return update();
  const root = document.documentElement, cls = ["vt-" + kind], cold = S.sheet === "closed";
  if (cold) cls.push("vt-cold"); // the old content was off screen: don't fade a ghost of it
  if (document.startViewTransition) {
    let ran = false;
    const run = () => { ran = true; update(); };
    try {
      root.classList.remove("vt-open", "vt-back", "vt-tab", "vt-cold"); root.classList.add(...cls);
      const seq = ++vtSeq, t = document.startViewTransition(run);
      t.ready.catch(() => { }); t.updateCallbackDone.catch(() => { });
      t.finished.catch(() => { }).finally(() => { if (seq === vtSeq) root.classList.remove(...cls); });
      return;
    } catch (e) { root.classList.remove(...cls); if (!ran) update(); return; }
  }
  // No View Transitions: the same motion as a keyframe animation on the panel itself.
  update();
  panel.classList.remove("p-open", "p-back", "p-tab"); void panel.offsetWidth; panel.classList.add("p-" + kind);
}
function openTab(tab) {
  S.tab = tab; S.sel = null;
  if (tab === "map") { setSheet("closed"); render(); return; }
  withTransition(render, "tab"); setSheet("full");
}
document.querySelectorAll(".ui-tab").forEach(b => b.addEventListener("click", () => openTab(b.dataset.tab)));
$("#locate-btn").addEventListener("click", () => locateMe());
$("#menu-btn").addEventListener("click", () => { const m = $("#menu"), open = m.hidden; m.hidden = !open; $("#menu-btn").setAttribute("aria-expanded", String(open)); });
document.addEventListener("click", e => { const m = $("#menu"); if (!m.hidden && !e.target.closest("#menu,#menu-btn")) { m.hidden = true; $("#menu-btn").setAttribute("aria-expanded", "false"); } });
document.addEventListener("keydown", e => {
  if (e.key !== "Escape" || $("#filters").open || $("#suggest").open || $("#install").open) return; // the sheets close themselves
  if (!$("#menu").hidden) { $("#menu").hidden = true; $("#menu-btn").setAttribute("aria-expanded", "false"); return; }
  if (!isDesktop() && S.sheet !== "closed") { S.sel = null; S.tab = "map"; setSheet("closed"); render(); }
});
// Drag the grabber: up opens, down closes; a tap toggles between peek and full.
(function sheetDrag() {
  const grab = $("#grab"); let y0 = null, t0 = 0, h = 0, base = 0, moved = false;
  const pos = () => S.sheet === "full" ? 0 : S.sheet === "peek" ? h * .54 : h;
  grab.addEventListener("pointerdown", e => { y0 = e.clientY; t0 = Date.now(); h = sheetEl.offsetHeight; base = pos(); moved = false; grab.setPointerCapture(e.pointerId); sheetEl.classList.add("dragging"); });
  grab.addEventListener("pointermove", e => { if (y0 === null) return; const dy = e.clientY - y0; if (Math.abs(dy) > 4) moved = true; sheetEl.style.transform = `translateY(${Math.max(0, Math.min(h, base + dy))}px)`; });
  grab.addEventListener("pointerup", e => {
    if (y0 === null) return; sheetEl.classList.remove("dragging"); sheetEl.style.transform = "";
    const dy = e.clientY - y0, v = dy / Math.max(1, Date.now() - t0), at = base + dy; y0 = null;
    if (!moved) return setSheet(S.sheet === "full" ? "peek" : "full");
    const next = v > .6 ? (S.sheet === "full" ? "peek" : "closed") : v < -.6 ? "full" : at < h * .27 ? "full" : at < h * .75 ? "peek" : "closed";
    if (next === "closed") { S.sel = null; S.tab = "map"; render(); }
    setSheet(next);
  });
  grab.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSheet(S.sheet === "full" ? "peek" : "full"); } });
})();
// The floating bars' sizes, for the sheet height (phone), the panel header (desktop) and the map controls.
(function measureBars() {
  const app = $("#app"), chips = $("#chips"), dock = $("#dock");
  const set = () => {
    app.style.setProperty("--top-h", Math.round(chips.getBoundingClientRect().bottom) + "px");
    app.style.setProperty("--dock-h", Math.round(Math.max(0, innerHeight - dock.getBoundingClientRect().top)) + "px");
  };
  set();
  if (window.ResizeObserver) { const ro = new ResizeObserver(set); ro.observe($("#topbar")); ro.observe(dock); }
  window.addEventListener("resize", set);
})();
const NEAR_KM = 25;
const walkText = d => d < 3 ? ` · ${Math.round(d / 5 * 60)} perc gyalog` : "";
const KIND_WORD = { mass: "mise", rorate: "rorate", conf: "gyónás" };
// "Legközelebb": the nearest church with a Mass still to come, then the next time of any kind at another church.
function renderNearest(rows) {
  const el = $("#nearest"); if (!el) return;
  if (S.loading || S.error) { el.innerHTML = ""; return; }
  const near = rows.filter(r => r.dist <= NEAR_KM);
  const firstMass = near.map(r => ({ r, n: nextOf({ items: r.di.items.filter(i => i.k === "mass" || i.k === "rorate") }) })).find(x => x.n.k);
  const other = near.filter(r => !firstMass || r.c.id !== firstMass.r.c.id).map(r => ({ r, n: nextOf(r.di) })).find(x => x.n.k);
  const row = x => `<button class="nx" data-id="${x.r.c.id}"><b class="tt tt-${x.n.cls}">${esc(x.n.t)}</b><span class="nt"><strong>${esc(x.r.c.name)}</strong>`
    + `<small>${KIND_WORD[x.n.k] || ""} · ${kmText(x.r.dist)}${walkText(x.r.dist)}</small></span></button>`;
  const list = [firstMass, other].filter(Boolean);
  el.innerHTML = `<h2 class="nh">Legközelebb</h2>` + (list.length ? list.map(row).join("")
    : `<p class="nempty">${isToday() ? "Ma már nincs több ismert alkalom a közelben" : "Nincs ismert alkalom a közelben"}</p>`);
  el.querySelectorAll(".nx").forEach(b => b.addEventListener("click", () => select(+b.dataset.id)));
}
const kmText = d => d < 1 ? Math.round(d * 1000 / 10) * 10 + " m" : (d < 10 ? d.toFixed(1).replace(".", ",") : Math.round(d)) + " km";

/* ---------- Rendering: list ---------- */
const panel = $("#panel");
panel.addEventListener("animationend", e => { if (e.target === panel) panel.classList.remove("p-open", "p-back", "p-tab"); });
function dayLabel(off) { const d = new Date(); d.setDate(d.getDate() + off); return off === 0 ? "Ma" : off === 1 ? "Holnap" : DAYN[d.getDay()] + ", " + shortDate(d); }
function dayShort(off) { const d = new Date(); d.setDate(d.getDate() + off); return off === 0 ? "Ma" : off === 1 ? "Holnap" : DAY_SHORT[d.getDay()] + ", " + shortDate(d); }

/* Filters: chips under the search field; the rest (day, place, Mass type, events, Rorate) in the ⋯ sheet. */
const chipHTML = (k, label, dot) => `<button class="ui-chip" type="button" data-f="${k}" aria-pressed="${S.f[k]}">${dot ? `<span class="dot" style="background:${dot}"></span>` : ""}${label}</button>`;
const hiddenFilters = () => (S.f.ev ? 1 : 0) + (S.f.rorate ? 1 : 0) + (S.f.tag ? 1 : 0);
function renderChips() {
  const n = hiddenFilters();
  $("#chips").innerHTML = `<button class="ui-chip daychip" type="button" data-sheet aria-haspopup="dialog" aria-label="Nap: ${esc(dayLabel(S.dayOffset))}. Szűrők megnyitása">${esc(dayShort(S.dayOffset))}</button>`
    + chipHTML("mass", "Mise", "var(--accent)") + chipHTML("conf", "Gyóntatás", "var(--penance)")
    + (isToday() ? chipHTML("open", "Most nyitva", "var(--open)") : "")
    + `<button class="ui-chip more" type="button" data-sheet aria-haspopup="dialog" aria-label="További szűrők${n ? ` (${n} bekapcsolva)` : ""}"><span aria-hidden="true">⋯</span>${n ? `<b class="badge" aria-hidden="true">${n}</b>` : ""}</button>`;
}
function renderFilters() {
  const ctx = dayContext(selDate());
  const opts = [...Array(8).keys()].map(i => `<option value="${i}" ${i === S.dayOffset ? "selected" : ""}>${dayLabel(i)}</option>`).join("");
  const ors = Object.keys(ORIGINS).map(k => `<option ${k === S.origin ? "selected" : ""}>${esc(k)}</option>`).join("")
    + (navigator.geolocation && !ORIGINS["Saját helyzetem"] ? `<option value="__me">Saját helyzetem…</option>` : "");
  const tagLabel = t => esc(C.tagLabel(t)[0].toUpperCase() + C.tagLabel(t).slice(1));
  $("#filters-body").innerHTML = `
    <label class="ui-field"><span>Nap</span><select id="day">${opts}</select></label>
    <label class="ui-field"><span>Távolság innen</span><select id="origin">${ors}</select></label>
    ${TAG_OPTIONS.length ? `<label class="ui-field"><span>A mise jellege</span><select id="tagf"><option value="">Bármilyen mise</option>${TAG_OPTIONS.map(t => `<option value="${esc(t)}" ${S.f.tag === t ? "selected" : ""}>${tagLabel(t)}</option>`).join("")}</select></label>` : ""}
    <div class="fchips" role="group" aria-label="További szűrők">${chipHTML("ev", "Esemény a héten", "var(--gold)")}${ctx.advent ? chipHTML("rorate", "Rorate", "var(--gold)") : ""}</div>`;
}
const filtersEl = $("#filters");
function openFilters() { renderFilters(); if (!filtersEl.open) filtersEl.showModal(); }
$("#filters-done").addEventListener("click", () => filtersEl.close());
filtersEl.addEventListener("click", e => {
  if (e.target === filtersEl) return filtersEl.close(); // tap on the backdrop
  const b = e.target.closest("[data-f]"); if (!b) return;
  S.f[b.dataset.f] = !S.f[b.dataset.f]; renderFilters(); render();
});
filtersEl.addEventListener("change", e => {
  const t = e.target;
  if (t.id === "day") setDayOffset(+t.value);
  else if (t.id === "origin") {
    if (t.value === "__me") { filtersEl.close(); return locateMe(); }
    S.origin = t.value; try { localStorage.setItem("harangszo", JSON.stringify({ origin: S.origin })); } catch (_) { }
  } else if (t.id === "tagf") S.f.tag = t.value;
  else return;
  render(); renderFilters();
});
$("#chips").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.hasAttribute("data-sheet")) return openFilters();
  S.f[b.dataset.f] = !S.f[b.dataset.f]; render();
});
let searchTimer;
$("#q").addEventListener("input", e => {
  S.q = e.target.value; clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    // With the panel open, typing shows the matching list; with only the map showing, the markers follow.
    if (S.sheet !== "closed" && (S.sel || S.tab === "saved")) { S.sel = null; S.tab = "list"; setSheet(S.sheet); }
    render();
  }, 150);
});

// A list card: name, address, distance; at most two tags (open state when known today, then the next times).
function cardHTML(r) {
  const di = r.di;
  const lang = i => { const l = i.g.find(t => t.startsWith("lang:")); return l ? " · " + esc(C.LANGS[l.slice(5)] || l.slice(5)) : S.f.tag && i.g.includes(S.f.tag) ? " · " + esc(C.tagLabel(S.f.tag)) : ""; };
  // A time the filters ask for comes first (the next confession when "Gyóntatás" is on, and so on).
  const isMass = i => i.k === "mass" || i.k === "rorate";
  const wanted = i => (S.f.conf && i.k === "conf") || (S.f.rorate && i.k === "rorate") || (S.f.tag ? isMass(i) && i.g.includes(S.f.tag) : S.f.mass && isMass(i));
  const up = upcoming(di.items).filter(i => i.k !== "ador").map((i, n) => ({ i, n })).sort((a, b) => wanted(b.i) - wanted(a.i) || a.n - b.n).map(x => x.i);
  const timeTag = i => `<span class="ui-tag t-${i.k === "mass" || i.k === "rorate" ? "mass" : i.k === "conf" ? "conf" : "ador"}">${i.t ? showT(i.t) + " " : ""}${i.k === "mass" ? "mise" + lang(i) : i.k === "rorate" ? "rorate" : i.k === "conf" ? "gyónás" : esc(i.what.length > 24 ? i.what.slice(0, 22) + "…" : i.what)}</span>`;
  const os = isToday() ? (r.os || openState(r.c, now())) : null;
  const tags = [];
  if (os && os.known) tags.push(`<span class="ui-tag ${os.open ? "t-open" : "t-muted"}">${esc(os.label)}</span>`);
  for (const i of up) { if (tags.length >= 2) break; tags.push(timeTag(i)); }
  if (!up.length) tags.push(`<span class="ui-tag t-muted">${!hasSchedule(r.c) && !di.feastMode ? "Még nincs feltöltött időpont" : isToday() ? "Ma már nincs több alkalom" : "Nincs alkalom ezen a napon"}</span>`);
  const where = [r.c.city, r.c.addr].filter(Boolean).join(", ");
  return `<li><button class="lcard ui-card" data-id="${r.c.id}" aria-current="${S.sel === r.c.id}">
    <span class="lc-top"><span class="lc-name">${esc(r.c.name)}</span><span class="lc-dist">${kmText(r.dist)}</span></span>
    <span class="lc-where">${esc(where)}</span>
    <span class="lc-tags">${tags.slice(0, 2).join("")}</span></button></li>`;
}
function bindCards() { panel.querySelector(".list")?.addEventListener("click", e => { const b = e.target.closest(".lcard"); if (b) select(+b.dataset.id); }); }
function renderList() {
  if (S.loading || S.error) { panel.innerHTML = `<div class="ui-empty"><p>${S.error ? esc(S.error) : "Templomok betöltése…"}</p></div>`; renderNearest([]); return; }
  const ctx = dayContext(selDate()), rows = filtered(), shown = rows.slice(0, LIST_LIMIT), more = rows.length - shown.length;
  const feastNames = ctx.feasts.map(k => C.FEAST_BY_KEY[k].name).join(", ");
  panel.innerHTML = `<div class="lhead pad"><h2>${S.q.trim() ? "Találatok" : "A közelben"}</h2><p class="summary" id="summary"></p>
    ${feastNames ? `<div class="feastline">Ünnep: <b>${esc(feastNames)}</b>. Ahol a templom megadta, az ünnepi miserend látszik.</div>` : ""}</div>
    <ul class="list pad">${shown.map(cardHTML).join("") || `<li class="ui-empty">Nincs a szűrőknek megfelelő templom. Próbálj másik napot vagy kapcsolj ki egy szűrőt.</li>`}
    ${more > 0 ? `<li class="ui-empty">További ${more.toLocaleString("hu-HU")} templom. Írj be egy települést, vagy válassz másik kiindulópontot.</li>` : ""}</ul>`;
  let nConf = 0; for (const r of rows) if (r.di.hasConf) nConf++;
  $("#summary").textContent = `${rows.length.toLocaleString("hu-HU")} templom · ${nConf} helyen gyóntatnak ${isToday() ? "ma" : "aznap"} · ${ctx.summer ? "nyári" : "téli"} időszámítás · távolság: ${S.origin}`;
  bindCards(); drawMarkers(rows); renderNearest(rows);
}
// Mentett: the saved churches, nearest first, whatever the filters say.
function renderSaved() {
  if (S.loading || S.error) { panel.innerHTML = `<div class="ui-empty"><p>${S.error ? esc(S.error) : "Templomok betöltése…"}</p></div>`; renderNearest([]); return; }
  const ctx = dayContext(selDate()), rows = filtered();
  const saved = Saved.ids().map(id => BY_ID.get(id)).filter(Boolean).map(c => ({ c, di: dayInfoCached(c, ctx), dist: distOf(c), os: null })).sort((a, b) => a.dist - b.dist);
  panel.innerHTML = `<div class="lhead pad"><h2>Mentett</h2>${saved.length ? `<p class="summary">${saved.length} templom · távolság: ${esc(S.origin)}</p>` : ""}</div>`
    + (saved.length ? `<ul class="list pad">${saved.map(cardHTML).join("")}</ul>`
      : `<div class="ui-empty"><p>Még nincs mentett templom. A templom oldalán a ♡ gombbal mentheted.</p></div>`);
  bindCards(); drawMarkers(rows); renderNearest(rows);
}
function locateMe() {
  const sum = $("#summary"); if (sum) sum.textContent = "Helymeghatározás…";
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(p => {
    ORIGINS["Saját helyzetem"] = [p.coords.latitude, p.coords.longitude]; S.origin = "Saját helyzetem";
    MapView.focus(p.coords.latitude, p.coords.longitude, 13); MapView.me?.(p.coords.latitude, p.coords.longitude); render();
  }, () => { render(); const s2 = $("#summary"); if (s2) s2.textContent = "A helyzeted nem érhető el. Engedélyezd a böngészőben, vagy válassz várost."; else { const h = $("#maphint"); h.hidden = false; h.textContent = "A helyzeted nem érhető el. Engedélyezd a böngészőben."; setTimeout(() => h.hidden = true, 4000); } }, { timeout: 10000, maximumAge: 300000 });
}

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
// Top bar of the detail: ‹ back, ♡ save to Mentett, ↗ share.
const HEART = `<svg width="20" height="20" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>`;
const saveLabel = on => on ? "Eltávolítás a kedvencek közül" : "Mentés a kedvencek közé";
const saveBtnHTML = c => { const on = Saved.has(c.id); return `<button class="d-ib savebtn" id="save-church" type="button" aria-pressed="${on}" aria-label="${saveLabel(on)}" title="${saveLabel(on)}">${HEART}</button>`; };
function setSaveBtn(b, on) { b.setAttribute("aria-pressed", String(on)); b.setAttribute("aria-label", saveLabel(on)); b.title = saveLabel(on); }
const svgI = d => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  route: svgI('<path d="M5 19 19 5"/><path d="M9 5h10v10"/>'),
  call: svgI('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>'),
  web: svgI('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  fix: svgI('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>'),
};
let toastTimer;
function toast(msg) {
  const t = $("#toast"); if (!t) return;
  t.textContent = msg; t.classList.add("on");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 2400);
}
// Share sheet where the device has one; otherwise copy the church's link.
async function shareChurch(c) {
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
// Same effect as the day select in the filter sheet.
function setDayOffset(off) { S.dayOffset = off; if (!isToday()) S.f.open = false; if (!C.inAdvent(selDate())) S.f.rorate = false; }
const KIND_TAG = { mass: ["t-mass", "mise"], rorate: ["t-mass", "rorate"], conf: ["t-conf", "gyónás"], ador: ["t-ador", "imádás"], prayer: ["t-ador", "ima"], ev: ["t-ador", "esemény"] };
const NEXT_WORD = { conf: "gyóntatás", ador: "szentségimádás", prayer: "ájtatosság", ev: "esemény" };
const inText = d => d < 60 ? `${d} perc múlva` : `${Math.floor(d / 60)} ó${d % 60 ? ` ${d % 60} p` : ""} múlva`;
const kindLabel = (c, k) => k === "mass" ? massWord(c) : k === "conf" ? "Gyóntatás" : k === "ador" ? "Szentségimádás" : k === "rorate" ? "Rorate" : k === "prayer" ? "Imaóra, ájtatosság" : "Esemény";
// The hero: the next Mass of the selected day (from now on, today), else its next time of any kind.
function nextHTML(c, di) {
  const m = now().getHours() * 60 + now().getMinutes();
  const up = di.items.filter(i => i.t && !i.away && (!isToday() || mins(i.end || i.t) >= m));
  const i = up.find(x => x.k === "mass" || x.k === "rorate") || up[0];
  if (!i) {
    if (noSchedule(c)) return `<div class="ui-empty d-empty" id="d-next"><p>Ehhez a templomhoz még nincs feltöltött időpont. Ha tudod a miserendet, küldd be a Javítás gombbal.</p></div>`;
    return `<p class="d-nomore" id="d-next">${isToday() ? "Ma már nincs több alkalom" : "Nincs alkalom ezen a napon"}</p>`;
  }
  const what = i.k === "mass" || i.k === "rorate" ? (c.rite === "gk" ? "liturgia" : "mise") : NEXT_WORD[i.k];
  const label = "Következő " + what + (isToday() ? "" : " · " + DAYN[selDate().getDay()].toLowerCase());
  const word = S.dayOffset === 0 ? "ma" : S.dayOffset === 1 ? "holnap" : shortDate(selDate());
  const extra = i.g.length ? C.tagLabel(i.g[0]) : i.k === "ev" || i.k === "prayer" ? i.what : i.n;
  const diff = mins(i.t) - m;
  return `<div class="ui-hero" id="d-next"><small>${esc(label)}</small><div class="t">${esc(showT(i.t))}</div><div class="w">${esc(word)}${extra ? " · " + esc(extra) : ""}</div>`
    + `${isToday() && diff > 0 && diff < 720 ? `<span class="in">${inText(diff)}</span>` : ""}</div>`;
}
// The selected day's times: feast line, then one grouped list (past times faded).
function dayBoxHTML(c, di) {
  const m = now().getHours() * 60 + now().getMinutes();
  const feast = di.feastMode === "dated" ? `<p class="d-feast">A templom heti miserendje szerint${di.feast ? " · " + esc(di.feast) : ""}${di.datedUrl ? ` · <a href="${esc(di.datedUrl)}" target="_blank" rel="noopener noreferrer">forrás</a>` : ""}</p>`
    : di.feast ? `<p class="d-feast">Ünnepi miserend · ${esc(di.feast)}${di.feastMode === "sunday" ? " (vasárnapi rend szerint)" : ""}</p>` : "";
  const rows = di.items.map(i => {
    const past = isToday() && i.t && mins(i.end || i.t) < m;
    const main = i.k === "ev" || i.k === "prayer" ? i.what : kindLabel(c, i.k);
    const sub = [i.end ? showT(i.end) + "-ig" : "", i.k === "prayer" ? "" : i.n, whoWhere(i)].filter(Boolean).join(" · ");
    const [cls, tag] = KIND_TAG[i.k] || KIND_TAG.ev;
    return `<li class="ui-row d-row${past ? " past" : ""}"><span class="d-t">${showT(i.t) || "–"}</span><span class="d-k">${esc(main)}${sub ? `<small>${esc(sub)}</small>` : ""}${tagsHTML(i.g)}</span>`
      + `<span class="ui-tag ${cls}">${i.k === "mass" && c.rite === "gk" ? "liturgia" : tag}</span></li>`;
  }).join("") || `<li class="ui-row d-row d-none">Nincs meghirdetett alkalom ezen a napon.</li>`;
  return `<div class="d-daybox" id="d-daybox">${feast}<ul class="ui-glist" id="d-day" aria-label="${esc(dayLabel(S.dayOffset))}">${rows}</ul></div>`;
}
const foldHTML = (id, title, body, count) => body
  ? `<details class="ui-fold" id="${id}"><summary>${title}${count ? `<span class="count">${count}</span>` : ""}</summary><div class="d-fold">${body}</div></details>` : "";
function renderDetail() {
  const c = BY_ID.get(S.sel); if (!c) { S.sel = null; return renderList(); }
  const ctx = dayContext(selDate()), di = dayInfoCached(c, ctx), os = openState(c, now());
  // The minute timer re-renders the page: keep open folds and the scroll position of the same church.
  const prev = panel.querySelector(".detail"), same = prev && +prev.dataset.id === c.id;
  const openFolds = same ? [...prev.querySelectorAll(".ui-fold[open]")].map(f => f.id) : [], top = same ? panel.scrollTop : 0;
  const dir = `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lon}`;
  const where = [c.city, c.addr].filter(Boolean).join(", ");
  const web = c.web ? (/^https?:/i.test(c.web) ? c.web : "https://" + c.web) : "";
  const acts = [`<a class="d-act" href="${dir}" target="_blank" rel="noopener noreferrer">${ICONS.route}<span>Útvonal</span></a>`,
    c.phone ? `<a class="d-act" href="tel:${esc(c.phone.replace(/[^\d+]/g, ""))}" aria-label="Hívás: ${esc(c.phone)}" title="${esc(c.phone)}">${ICONS.call}<span>Hívás</span></a>` : "",
    web ? `<a class="d-act" href="${esc(web)}" target="_blank" rel="noopener noreferrer" title="${esc(c.web)}">${ICONS.web}<span>Weboldal</span></a>` : "",
    `<button class="d-act" type="button" id="go-suggest" aria-haspopup="dialog">${ICONS.fix}<span>Javítás</span></button>`].filter(Boolean);
  const showDays = !noSchedule(c) || c.ev.length > 0;
  const days = [...Array(7).keys()].map(i => `<button type="button" data-off="${i}" aria-pressed="${i === S.dayOffset}" aria-label="${esc(dayLabel(i))}"><span>${DAY_SHORT[dayAt(i).getDay()]}</span><b>${dayAt(i).getDate()}</b></button>`).join("");
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
  panel.innerHTML = `<div class="detail pad" data-id="${c.id}">
    <div class="d-bar"><button class="d-ib" id="back" type="button" aria-label="Vissza" title="Vissza">‹</button><span class="sp"></span>${saveBtnHTML(c)}<button class="d-ib" id="share" type="button" aria-label="Megosztás" title="Megosztás">↗</button></div>
    <div class="d-tags">${os.label ? `<span class="ui-tag ${os.known && os.open ? "t-open" : "t-muted"}">${esc(os.label)}</span>` : ""}<span class="ui-tag t-muted">${riteName(c)}</span></div>
    <h2 class="d-name">${esc(c.name)}</h2>
    <p class="d-where">${esc(where)} · ${kmText(distOf(c))} (${esc(S.origin)})</p>
    ${c.approx ? `<p class="d-approx">A templom helye a térképen hozzávetőleges (a település közepe). Útvonaltervezés előtt ellenőrizd a címet.</p>` : ""}
    ${nextHTML(c, di)}
    <div class="d-actions" style="--n:${acts.length}">${acts.join("")}</div>
    ${showDays ? `<div class="d-days" role="group" aria-label="Nap">${days}</div>${dayBoxHTML(c, di)}` : ""}
    ${folds ? `<div class="ui-glist d-folds">${folds}</div>` : ""}
  </div>`;
  $("#back").addEventListener("click", () => {
    S.sel = null;
    if (S.tab === "map" && !isDesktop()) { setSheet("closed"); render(); } else withTransition(render, "back");
  });
  $("#save-church").addEventListener("click", e => setSaveBtn(e.currentTarget, Saved.toggle(c.id)));
  $("#share").addEventListener("click", () => shareChurch(c));
  $("#go-suggest").addEventListener("click", () => openSuggest(c));
  panel.querySelector(".d-days")?.addEventListener("click", e => {
    const b = e.target.closest("button[data-off]"); if (!b) return;
    setDayOffset(+b.dataset.off);
    panel.querySelectorAll(".d-days button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    const d2 = dayInfoCached(c, dayContext(selDate()));
    $("#d-next").outerHTML = nextHTML(c, d2);
    $("#d-daybox").outerHTML = dayBoxHTML(c, d2);
    renderChips(); drawMarkers(filtered());
  });
  for (const id of openFolds) document.getElementById(id)?.setAttribute("open", "");
  drawMarkers(lastRows.length ? lastRows : filtered());
  panel.scrollTop = top;
}

/* ---------- Suggestions: database when live, otherwise a pre-filled GitHub issue ---------- */
const TYPES = { conf: "Gyóntatási időpont", mass: "Mise időpont", hours: "Nyitvatartás", event: "Esemény", place: "Hely vagy egyéb" };
function suggestForm(c) {
  return `<p class="s-church">${esc(c.name)}</p><form class="suggest" id="s-form" novalidate>
    <label class="ui-field" for="s-type"><span>Mit javítanál?</span><select id="s-type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
    <label class="ui-field" for="s-text"><span>Leírás</span><textarea id="s-text" maxlength="600" rows="4" placeholder="Pl. Szerdánként 17:00–18:00 között is gyóntatnak, a hirdetőtábla szerint."></textarea></label>
    ${LIVE ? `<label class="ui-field" for="s-contact"><span>E-mail vagy telefon (nem kötelező, csak ha visszakérdeznénk)</span><input id="s-contact" type="text" maxlength="200" autocomplete="email"></label>` : ""}
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
      st.textContent = "Köszönjük! A javaslat ellenőrzésre vár."; st.className = "status ok";
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
  const closeMenu = () => { $("#menu").hidden = true; $("#menu-btn").setAttribute("aria-expanded", "false"); };
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); prompt = e; update(); });
  window.addEventListener("appinstalled", () => { prompt = null; update(); });
  btn.addEventListener("click", async () => {
    closeMenu();
    if (prompt) { const p = prompt; prompt = null; try { await p.prompt(); await p.userChoice; } catch (_) { } update(); return; }
    if (ios && !sheet.open) sheet.showModal();
  });
  $("#install-done").addEventListener("click", () => sheet.close());
  sheet.addEventListener("click", e => { if (e.target === sheet) sheet.close(); }); // tap on the backdrop
  update();
})();

/* ---------- Map ---------- */
/* The map never draws every church one by one. Below street level, churches that are close together on screen
   are merged into one round marker with their number ("37"); tapping it zooms in on them. A church that stands
   alone keeps its own marker: a dot when zoomed out, a pill with the next time when zoomed in. From SHOW_ALL_ZOOM
   on, every church has its own marker. */
const HU_BOUNDS = { s: 45.7, w: 16.1, n: 48.6, e: 22.9 };
// How far the map may pan. Wider than Hungary on purpose: if the screen shows more than this, the map is pinned
// to its middle and cannot shift Hungary out from under the side panel.
const PAN_BOUNDS = { s: 43.5, w: 11.5, n: 50.5, e: 27.5 };
const SHOW_ALL_ZOOM = 14, LABEL_ZOOM = 12.5, CLUSTER_PX = 72;
// Web Mercator world pixels at a zoom level (both map libraries use 256px tiles).
const worldPx = (lat, lon, z) => { const k = 256 * 2 ** z, sn = Math.sin(lat * Math.PI / 180);
  return [(lon + 180) / 360 * k, (0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * k]; };
const clusterSize = n => n < 10 ? 30 : n < 100 ? 36 : n < 1000 ? 42 : 50;
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
// Room the floating UI takes on each side of the map, so the first view of Hungary is not hidden under the
// side panel (desktop), the brand chip, the zoom buttons or the bottom dock.
function fitPadding() {
  const W = innerWidth, H = innerHeight, sheet = $("#sheet"), ctrls = $(".ctrls"), dock = $(".dock");
  const desk = isDesktop(), gap = desk ? 24 : 8, panelOpen = desk && S.sheet !== "closed";
  // Phone: the search row and the chip row float over the top. Desktop: they sit in the side panel (counted on
  // the left); with the panel closed they float over the map like on a phone.
  return {
    top: (panelOpen ? 0 : $("#chips").getBoundingClientRect().bottom) + gap,
    bottom: Math.max(0, H - dock.getBoundingClientRect().top) + gap,
    left: (panelOpen ? sheet.offsetLeft + sheet.offsetWidth : 0) + gap,
    right: (desk ? W - ctrls.offsetLeft : 0) + gap };
}
const OSM_DATA_CREDIT = 'Templomhelyek: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

// Church markers are created once per church on first show; each draw only adds/removes the ones whose visibility
// changed and re-styles the ones whose colour or selection changed. Cluster markers are thrown away once hidden.
function makeDiffer(create, restyle, addMany, removeMany) {
  const cache = new Map(); let shown = new Set();
  return list => {
    const next = new Set(), toAdd = [];
    for (const p of list) {
      let e = cache.get(p.key);
      if (!e) { e = { mk: create(p), sig: "", temp: !!p.n }; cache.set(p.key, e); }
      const sig = p.cls + "|" + (p.label || "") + (p.dot ? "." : "") + (p.sel ? "*" : "") + (p.n || "");
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
// Tapping a number zooms in until its churches spread out.
const openCluster = p => MapView.zoomTo(p.b);
function leafletView() {
  const map = L.map("map", { minZoom: 6, maxZoom: 18, zoomSnap: .25, zoomControl: false, maxBounds: [[PAN_BOUNDS.s, PAN_BOUNDS.w], [PAN_BOUNDS.n, PAN_BOUNDS.e]] });
  // Light or dark base map with the site's theme (CARTO basemaps on OpenStreetMap data).
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
  const icon = p => { const k = p.cls + p.label + p.dot + p.sel + (p.n || ""); return icons[k] || (icons[k] = L.divIcon({ className: "mkicon", iconSize: [0, 0],
    html: p.n ? `<div class="mkclu mk-${p.cls}" style="--s:${clusterSize(p.n)}px" aria-label="${p.n} templom">${p.n.toLocaleString("hu-HU")}</div>` : p.dot ? `<div class="mkdot mk-${p.cls} ${p.sel ? "sel" : ""}"></div>` : `<div class="mkwrap ${p.sel ? "sel" : ""}"><span class="mk mk-${p.cls}">${esc(p.label)}</span></div>` })); };
  const draw = makeDiffer(
    p => { const mk = L.marker([p.lat, p.lon], { title: p.n ? `${p.n} templom – nagyíts rá` : p.c.name, icon: icon({ cls: "none", label: "–", dot: true, sel: false }), keyboard: false });
      mk.on("click", () => p.n ? openCluster(p) : select(p.c.id)); return mk; },
    (mk, p) => { mk.setIcon(icon(p)); mk.setZIndexOffset(p.sel ? 1000 : p.n ? 500 + Math.min(p.n, 400) : Math.round(p.c.score) + (p.cls === "none" ? 0 : 200)); },
    arr => arr.forEach(m => layer.addLayer(m)),
    arr => arr.forEach(m => layer.removeLayer(m)));
  let resizeT; window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { map.invalidateSize(); queueMarkers(); }, 150); });
  map.on("moveend", () => queueMarkers());
  return {
    draw, ready: () => true,
    view() { const b = map.getBounds().pad(0.05); return { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast(), zoom: map.getZoom() }; },
    focus(lat, lon, z) { map.flyTo([lat, lon], Math.max(map.getZoom(), z), { duration: .5 }); },
    zoomTo(b) { const z = map.getZoom(), t = Math.min(map.getBoundsZoom([[b.s, b.w], [b.n, b.e]], false, L.point(60, 60)), 17);
      map.flyTo([(b.s + b.n) / 2, (b.w + b.e) / 2], Math.max(t, z + 1.5), { duration: .5 }); },
    me(lat, lon) { if (meMk) meMk.setLatLng([lat, lon]); else meMk = L.marker([lat, lon], { icon: L.divIcon({ className: "mkicon", iconSize: [0, 0], html: '<div class="me-dot"></div>' }), interactive: false, zIndexOffset: 2000 }).addTo(map); }
  };
}
// Google Maps in the same look as the Leaflet map: muted light or dark style, no Google buttons, time pills as markers.
const GM_LIGHT = [{ featureType: "poi", stylers: [{ visibility: "off" }] }, { featureType: "transit", stylers: [{ visibility: "off" }] },
  { elementType: "geometry", stylers: [{ saturation: -60 }] }, { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
  { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#c9d6e6" }] }, { featureType: "landscape", elementType: "geometry", stylers: [{ color: "#f1ece1" }] }];
const GM_DARK = [{ featureType: "poi", stylers: [{ visibility: "off" }] }, { featureType: "transit", stylers: [{ visibility: "off" }] },
  { elementType: "geometry", stylers: [{ color: "#1b1814" }] }, { elementType: "labels.text.fill", stylers: [{ color: "#948a79" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#14120f" }] }, { featureType: "road", elementType: "geometry", stylers: [{ color: "#2a251f" }] },
  { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] }, { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#332d26" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#1a2230" }] }, { featureType: "administrative", elementType: "geometry.stroke", stylers: [{ color: "#4a4339" }] }];
const pillSVG = (fill, ink, ring, label, sel) => {
  const w = Math.max(40, 12 + label.length * 7.4), h = 24, W = w + 8, H = h + 8;
  return { url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${sel ? `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="${H / 2 - 1}" fill="none" stroke="#c9971c" stroke-width="3"/>` : ""}
    <rect x="4" y="4" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" stroke="${ring}" stroke-width="2"/>
    <text x="${W / 2}" y="${H / 2 + 4}" text-anchor="middle" font-family="'Source Sans 3',system-ui,sans-serif" font-size="11" font-weight="600" fill="${ink}">${label.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text></svg>`), w: W, h: H };
};
const cluSVG = (fill, ink, ring, label, d) => "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}" viewBox="0 0 ${d} ${d}">
  <circle cx="${d / 2}" cy="${d / 2}" r="${d / 2 - 1}" fill="${fill}" opacity=".28"/><circle cx="${d / 2}" cy="${d / 2}" r="${d / 2 - 4}" fill="${fill}" stroke="${ring}" stroke-width="2"/>
  <text x="${d / 2}" y="${d / 2 + 4.5}" text-anchor="middle" font-family="'Source Sans 3',system-ui,sans-serif" font-size="${d > 50 ? 13 : 12}" font-weight="700" fill="${ink}">${label}</text></svg>`);
const dotSVG = (fill, ring, sel) => "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">${sel ? '<circle cx="10" cy="10" r="9" fill="none" stroke="#c9971c" stroke-width="3"/>' : ""}<circle cx="10" cy="10" r="6" fill="${fill}" stroke="${ring}" stroke-width="2"/></svg>`);
function googleView() {
  let gmap = null, pendingFocus = null, draw = null, meMk = null, moved = false;
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const pal = () => ({ mass: [css("--accent"), css("--on-accent")], conf: [css("--penance"), css("--on-penance")], none: [css("--mk-none-bg"), css("--mk-none-ink")], ring: css("--surface"), border: css("--border") });
  let colors = null, iconCache = {};
  const icon = p => {
    const k = p.cls + p.label + p.dot + p.sel + (p.n || ""); if (iconCache[k]) return iconCache[k];
    const [fill, ink] = colors[p.cls], ring = p.cls === "none" ? colors.border : colors.ring;
    if (p.n) { const d = clusterSize(p.n) + 6; return iconCache[k] = { url: cluSVG(fill, ink, colors.ring, p.n.toLocaleString("hu-HU"), d), scaledSize: new google.maps.Size(d, d), anchor: new google.maps.Point(d / 2, d / 2) }; }
    if (p.dot) return iconCache[k] = { url: dotSVG(p.cls === "none" ? colors.border : fill, colors.ring, p.sel), scaledSize: new google.maps.Size(20, 20), anchor: new google.maps.Point(10, 10) };
    const sv = pillSVG(fill, ink, ring, p.label, p.sel);
    return iconCache[k] = { url: sv.url, scaledSize: new google.maps.Size(sv.w, sv.h), anchor: new google.maps.Point(sv.w / 2, sv.h / 2) };
  };
  window.__initGoogle = () => {
    colors = pal();
    gmap = new google.maps.Map(document.getElementById("map"), { center: { lat: 47.16, lng: 19.5 }, zoom: 7, isFractionalZoomEnabled: true, disableDefaultUI: true, keyboardShortcuts: false,
      gestureHandling: "greedy", clickableIcons: false, backgroundColor: css("--land"), styles: dark.matches ? GM_DARK : GM_LIGHT,
      restriction: { latLngBounds: { north: PAN_BOUNDS.n, south: PAN_BOUNDS.s, west: PAN_BOUNDS.w, east: PAN_BOUNDS.e } } });
    // Fit twice: on the first call the map has no size yet and its pan limit keeps it centred; once it has
    // drawn, the padding can shift Hungary out from under the side panel.
    const fitHU = () => gmap.fitBounds({ north: HU_BOUNDS.n, south: HU_BOUNDS.s, west: HU_BOUNDS.w, east: HU_BOUNDS.e }, fitPadding());
    fitHU(); google.maps.event.addListenerOnce(gmap, "idle", () => { if (!pendingFocus && !moved) fitHU(); });
    dark.addEventListener?.("change", () => { gmap.setOptions({ styles: dark.matches ? GM_DARK : GM_LIGHT }); colors = pal(); iconCache = {}; queueMarkers(); });
    draw = makeDiffer(
      p => { const mk = new google.maps.Marker({ position: { lat: p.lat, lng: p.lon }, title: p.n ? `${p.n} templom – nagyíts rá` : p.c.name, optimized: true });
        mk.addListener("click", () => p.n ? openCluster(p) : select(p.c.id)); return mk; },
      (mk, p) => { mk.setIcon(icon(p)); mk.setZIndex(p.sel ? 1000 : p.n ? 500 + Math.min(p.n, 400) : Math.round(p.c.score) + (p.cls === "none" ? 0 : 200)); },
      arr => arr.forEach(m => m.setMap(gmap)),
      arr => arr.forEach(m => m.setMap(null)));
    gmap.addListener("idle", () => queueMarkers());
    if (pendingFocus) api.focus(...pendingFocus);
  };
  $("#zoom-in").addEventListener("click", () => gmap && gmap.setZoom(gmap.getZoom() + 1)); $("#zoom-out").addEventListener("click", () => gmap && gmap.setZoom(gmap.getZoom() - 1));
  window.gm_authFailure = () => { $("#notice").innerHTML = "<b>Térképhiba.</b> A Google Maps kulcs nem érvényes ehhez a címhez. Ellenőrizd a kulcs webhely-korlátozását."; };
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
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: colors.mass[0], fillOpacity: 1, strokeColor: "#fff", strokeWeight: 3 } }); }
  };
  return api;
}
const MapView = MAPS_KEY ? googleView() : (typeof L !== "undefined" ? leafletView() : { draw() { }, ready: () => false, view() { }, focus() { }, zoomTo() { } });
if (!MAPS_KEY && typeof L === "undefined") Offline.mapFailed();

let mapRows = [], markerJob = null;
function drawMarkers(rows) { mapRows = rows; queueMarkers(); }
// Deferred so the list paints first; only the latest request runs.
function queueMarkers() {
  if (markerJob) (window.cancelIdleCallback || clearTimeout)(markerJob);
  markerJob = window.requestIdleCallback ? requestIdleCallback(updateMarkers, { timeout: 250 }) : setTimeout(updateMarkers, 50);
}
function updateMarkers() {
  markerJob = null;
  if (!MapView.ready()) return;
  const v = MapView.view(), inView = [];
  for (const r of mapRows) { const c = r.c; if (c.lat >= v.s && c.lat <= v.n && c.lon >= v.w && c.lon <= v.e) inView.push(r); }
  // Zoomed in: a pill with the next time; zoomed out: a coloured dot.
  const dot = v.zoom < LABEL_ZOOM;
  const one = (r, sel) => { const n = nextOf(r.di); return { key: r.c.id, c: r.c, lat: r.c.lat, lon: r.c.lon, cls: n.cls, label: n.t, dot, sel }; };
  const list = [];
  if (v.zoom >= SHOW_ALL_ZOOM) for (const r of inView) list.push(one(r, S.sel === r.c.id));
  else {
    // Grid clustering in screen pixels: churches in the same CLUSTER_PX cell become one numbered marker.
    const cells = new Map(), z = v.zoom;
    for (const r of inView) {
      if (S.sel === r.c.id) continue;
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
      let la = 0, lo = 0, s = 90, w = 180, n = -90, e = -180, mass = false, conf = false;
      for (const r of g) { const c = r.c; la += c.lat; lo += c.lon; s = Math.min(s, c.lat); n = Math.max(n, c.lat); w = Math.min(w, c.lon); e = Math.max(e, c.lon);
        const nx = nextOf(r.di).cls; if (nx === "mass") mass = true; else if (nx === "conf") conf = true; }
      // Colour: a Mass still to come in the group → accent; only confession → violet; otherwise neutral.
      list.push({ key: `g${z}:${k}`, n: g.length, lat: la / g.length, lon: lo / g.length, b: { s, w, n, e }, cls: mass ? "mass" : conf ? "conf" : "none", label: "", dot: false, sel: false });
    }
  }
  if (S.sel && !list.some(p => p.sel)) { const c = BY_ID.get(S.sel); if (c) { const n = nextOf(dayInfoCached(c, dayContext(selDate()))); list.push({ key: c.id, c, lat: c.lat, lon: c.lon, cls: n.cls, label: n.t, dot, sel: true }); } }
  MapView.draw(list);
  const hint = $("#maphint"); if (hint) hint.hidden = true;
}
function select(id) {
  S.sel = id;
  const c = BY_ID.get(id);
  if (c) MapView.focus(c.lat, c.lon, 15);
  withTransition(render, "open");
  if (S.sheet === "closed" || isDesktop()) setSheet(isDesktop() ? "full" : "peek");
}

/* ---------- Boot ---------- */
function render() { renderChips(); S.sel ? renderDetail() : S.tab === "saved" ? renderSaved() : renderList(); }
$("#notice").innerHTML = LIVE
  ? `<b>Fejlesztés alatt.</b> Az időpontokat a plébániák és a hívek töltik fel, így sok templomnál még hiányoznak. Indulás előtt ellenőrizd a plébánián. ${OSM_DATA_CREDIT}.`
  : `<b>Bemutató.</b> A templomok valósak, de a mise-, gyóntatási és nyitvatartási időpontok kitalált mintaadatok. Indulás előtt mindig ellenőrizd a plébánián.`;
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
    render();
  });
}
// A link like ./#t=123 (e.g. from the parish page) opens that church once the data is there.
let deepLink = +((location.hash.match(/t=(\d+)/) || [])[1] || 0);
const openDeepLink = () => { if (deepLink && BY_ID.has(deepLink)) { const id = deepLink; deepLink = 0; select(id); } };
setSheet(S.sheet); render(); boot(); openDeepLink();
setInterval(() => { if (!S.loading && isToday() && !typing()) render(); }, 60000);
