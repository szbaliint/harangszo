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
    onlyServices: !c.hours, hours: c.hours || [], svc, feastSunday: c.feastSunday || [], ev: c.ev, imp: c.imp ?? 60 };
}
function fromDb(c) {
  return { id: c.id, name: c.name, city: c.city || "", addr: c.address || "", rite: c.rite, lat: c.lat, lon: c.lon,
    web: c.website, phone: c.phone, onlyServices: !!c.open_only_services,
    hours: (c.hours || []).map(h => ({ days: h.days, o: h.opens, c: h.closes })),
    svc: (c.services || []).map(s => ({ k: KIND[s.kind] || "mass", d: s.days || [], t: s.start, u: s.end || null, n: s.note, p: s.period || "all", feast: s.feast || null,
      v: s.valid || null, w: s.weeks && s.weeks.length ? s.weeks : null, e: s.every || null, a: s.anchor || null, g: s.tags || [] })),
    feastSunday: c.feast_sunday || [], imp: c.imp ?? 30,
    note: c.schedule_note || "", source: c.schedule_source || null, sourceUrl: c.schedule_source_url || null, updated: c.schedule_updated || null, approx: !!c.location_approx,
    ev: (c.events || []).map(e => ({ date: e.date, t: e.start || "", title: e.title, n: e.note })),
    // Times for given dates from the parish's own weekly schedule; on those dates they replace the regular rules.
    dated: (c.dated || []).map(d => ({ date: d.date, k: KIND[d.kind] || "mass", d: [], t: d.start, u: d.end || null, n: d.note, g: d.tags || [], url: d.url || null })) };
}
function setChurches(list) {
  CHURCHES = list;
  BY_ID = new Map(list.map(c => [c.id, c]));
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
  return { date, dow: date.getDay(), key: ymd(date), summer: C.isSummerTime(date), advent: C.inAdvent(date), feasts: C.feastsOn(date) };
}
// Seasons: a date range (`v`) wins; otherwise the period's own rule (clock change, Advent, Lent, school year… see calendar.js).
const seasonOk = (s, ctx) => C.inPeriod(ctx.date, s.p, s.v);
// Week of the month and "every n-th week".
const weekOk = (s, ctx) => C.weekOk(ctx.date, s.w) && C.everyOk(ctx.date, s.e, s.a);
const tagsOf = s => s.g || [];
const tagsHTML = g => g && g.length ? `<span class="tags">${g.map(t => `<span class="tag ${t.startsWith("lang:") ? "lang" : t === "irregular" ? "warn" : ""}">${esc(C.tagLabel(t))}</span>`).join("")}</span>` : "";
function dayInfo(c, ctx) {
  let rows, feast = null, feastMode = null;
  const dated = (c.dated || []).filter(d => d.date === ctx.key);
  const custom = ctx.feasts.length ? c.svc.filter(s => s.feast && ctx.feasts.includes(s.feast)) : [];
  const sundayFeast = ctx.feasts.find(k => c.feastSunday.includes(k));
  if (dated.length) { rows = dated; feastMode = "dated"; feast = ctx.feasts.length ? C.FEAST_BY_KEY[ctx.feasts[0]]?.name : null; }
  else if (custom.length) { rows = custom; feast = C.FEAST_BY_KEY[custom[0].feast]?.name; feastMode = "custom"; }
  else if (sundayFeast) { rows = c.svc.filter(s => isRegular(s) && s.k !== "rorate" && seasonOk(s, ctx) && !s.w && !s.e && s.d.includes(0)); feast = C.FEAST_BY_KEY[sundayFeast]?.name; feastMode = "sunday"; }
  else rows = c.svc.filter(s => isRegular(s) && seasonOk(s, ctx) && weekOk(s, ctx) && s.d.includes(ctx.dow) && (s.k !== "rorate" || ctx.advent));
  const items = rows.map(s => ({ k: s.k, t: s.t, end: s.k === "mass" || s.k === "rorate" ? null : s.u, n: s.k === "prayer" ? "" : s.n, g: tagsOf(s),
    what: s.k === "mass" ? massWord(c) : s.k === "rorate" ? "Rorate" : s.k === "conf" ? "Gyóntatás" : s.k === "prayer" ? (s.n || "Ájtatosság") : "Szentségimádás" }));
  for (const e of c.ev) if (e.date === ctx.key) items.push({ k: "ev", t: e.t, end: null, what: e.title, n: e.n, g: [] });
  items.sort((a, b) => mins(a.t) - mins(b.t));
  return { items, feast, feastMode, datedUrl: dated[0]?.url || null,
    hasMass: items.some(i => i.k === "mass" || i.k === "rorate"), hasConf: items.some(i => i.k === "conf"), hasRorate: items.some(i => i.k === "rorate") };
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
  const items = di.items.filter(i => (i.k === "mass" || i.k === "rorate" || i.k === "conf") && i.t);
  const up = isToday() ? items.filter(i => mins(i.end || i.t) >= m) : items;
  const i = up[0];
  return i ? { t: showT(i.t), cls: i.k === "conf" ? "conf" : "mass", k: i.k } : { t: "–", cls: "none", k: null };
}

/* ---------- Sheet, tabs, nearest strip ---------- */
const sheetEl = $("#sheet"), isDesktop = () => window.matchMedia("(min-width:900px)").matches;
function setSheet(state) {
  if (isDesktop() && state === "peek") state = "full";
  S.sheet = state; sheetEl.dataset.state = state;
  document.querySelectorAll(".tab").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tab === (state === "closed" ? "map" : S.tab))));
}
function openTab(tab) {
  S.tab = tab;
  if (tab === "map") { S.sel = null; setSheet("closed"); render(); return; }
  S.sel = null; render(); setSheet("full");
  if (tab === "search") setTimeout(() => $("#q")?.focus(), 250);
}
document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => openTab(b.dataset.tab)));
$("#filter-btn").addEventListener("click", () => { openTab("list"); });
$("#locate-btn").addEventListener("click", () => locateMe());
$("#menu-btn").addEventListener("click", () => { const m = $("#menu"), open = m.hidden; m.hidden = !open; $("#menu-btn").setAttribute("aria-expanded", String(open)); });
document.addEventListener("click", e => { const m = $("#menu"); if (!m.hidden && !e.target.closest("#menu,#menu-btn")) { m.hidden = true; $("#menu-btn").setAttribute("aria-expanded", "false"); } });
document.addEventListener("keydown", e => { if (e.key === "Escape") { if (!$("#menu").hidden) { $("#menu").hidden = true; return; } if (!isDesktop() && S.sheet !== "closed") { S.sel = null; S.tab = "map"; setSheet("closed"); render(); } } });
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
const NEAR_KM = 25;
function renderNearest(rows) {
  const el = $("#nearest"); if (!el) return;
  if (S.loading || S.error) { el.innerHTML = ""; return; }
  const withNext = rows.filter(r => r.dist <= NEAR_KM).map(r => ({ r, n: nextOf(r.di) })).filter(x => x.n.k);
  const two = withNext.slice(0, 2);
  // The central button: the nearest church with a Mass still to come (confession times don't count here).
  const firstMass = rows.filter(r => r.dist <= NEAR_KM).map(r => ({ r, n: nextOf({ items: r.di.items.filter(i => i.k === "mass" || i.k === "rorate") }) })).find(x => x.n.k);
  const card = x => { const c = x.r.c, os = isToday() ? openState(c, now()) : null;
    return `<button class="ncard" data-id="${c.id}"><span class="mk mk-${x.n.cls}">${esc(x.n.t)}</span><span class="nt"><span class="nn">${esc(c.name)}</span><span class="nm">${kmText(x.r.dist)}${os && os.known && os.open ? "<i title=\"Nyitva\"></i>" : ""}</span></span></button>`; };
  const empty = `<div class="ncard empty">${isToday() ? "Ma már nincs több ismert alkalom a közelben" : "Nincs ismert alkalom a közelben"}</div>`;
  el.innerHTML = (two[0] ? card(two[0]) : empty)
    + `<button class="nmain" id="nmain" ${firstMass ? "" : "disabled"} title="Legközelebbi mise${firstMass ? ": " + esc(firstMass.r.c.name) + ", " + firstMass.n.t : ""}" aria-label="Legközelebbi mise${firstMass ? ": " + esc(firstMass.r.c.name) + ", " + firstMass.n.t : " – nincs a közelben"}">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v2M7 17V11a5 5 0 0 1 10 0v6"/><path d="M5 17h14"/><path d="M10.5 20a1.5 1.5 0 0 0 3 0"/></svg></button>`
    + (two[1] ? card(two[1]) : two[0] ? `<div></div>` : "");
  el.querySelectorAll(".ncard[data-id]").forEach(b => b.addEventListener("click", () => select(+b.dataset.id)));
  $("#nmain")?.addEventListener("click", () => firstMass && select(firstMass.r.c.id));
}
const kmText = d => d < 1 ? Math.round(d * 1000 / 10) * 10 + " m" : (d < 10 ? d.toFixed(1).replace(".", ",") : Math.round(d)) + " km";
function updateFilterBadge() {
  const n = ["mass", "conf", "rorate", "open", "ev"].filter(k => S.f[k]).length + (S.f.tag ? 1 : 0) + (S.dayOffset ? 1 : 0);
  const b = $("#filter-count"); b.hidden = !n; b.textContent = n; $("#filter-btn").classList.toggle("on", n > 0);
}

/* ---------- Rendering: list ---------- */
const panel = $("#panel");
function dayLabel(off) { const d = new Date(); d.setDate(d.getDate() + off); return off === 0 ? "Ma" : off === 1 ? "Holnap" : DAYN[d.getDay()] + ", " + shortDate(d); }
function controlsHTML(ctx) {
  const opts = [...Array(8).keys()].map(i => `<option value="${i}" ${i === S.dayOffset ? "selected" : ""}>${dayLabel(i)}</option>`).join("");
  const ors = Object.keys(ORIGINS).map(k => `<option ${k === S.origin ? "selected" : ""}>${esc(k)}</option>`).join("")
    + (navigator.geolocation && !ORIGINS["Saját helyzetem"] ? `<option value="__me">Saját helyzetem…</option>` : "");
  const chip = (k, cls, label, dot) => `<button class="chip ${cls}" data-f="${k}" aria-pressed="${S.f[k]}"><span class="dot" style="background:${dot}"></span>${label}</button>`;
  const feastNames = ctx.feasts.map(k => C.FEAST_BY_KEY[k].name).join(", ");
  return `<div class="controls pad">
    <div class="row">
      <label class="search" for="q"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="q" type="search" placeholder="Templom vagy település" value="${esc(S.q)}" autocomplete="off"></label>
    </div>
    <div class="row">
      <select id="day" class="sel" aria-label="Nap">${opts}</select>
      <select id="origin" class="sel" aria-label="Távolság innen">${ors}</select>
    </div>
    ${TAG_OPTIONS.length ? `<div class="row"><select id="tagf" class="sel" aria-label="A mise jellege"><option value="">Bármilyen mise</option>${TAG_OPTIONS.map(t => `<option value="${esc(t)}" ${S.f.tag === t ? "selected" : ""}>${esc(C.tagLabel(t)[0].toUpperCase() + C.tagLabel(t).slice(1))}</option>`).join("")}</select></div>` : ""}
    <div class="chips" role="group" aria-label="Szűrők">
      ${chip("conf", "conf", "Gyóntatás", "var(--penance)")}${chip("mass", "mass", "Mise", "var(--accent)")}${ctx.advent ? chip("rorate", "ev", "Rorate", "var(--gold)") : ""}${isToday() ? chip("open", "open", "Most nyitva", "var(--open)") : ""}${chip("ev", "ev", "Esemény a héten", "var(--gold)")}
    </div>
    ${feastNames ? `<div class="feastline">Ünnep: <b>${esc(feastNames)}</b>. Ahol a templom megadta, az ünnepi miserend látszik.</div>` : ""}
    <div class="summary" id="summary"></div>
  </div>`;
}
function cardHTML(r) {
  const di = r.di, up = upcoming(di.items).filter(i => i.k !== "ador").slice(0, 3);
  const lang = i => { const l = i.g.find(t => t.startsWith("lang:")); return l ? " · " + esc(C.LANGS[l.slice(5)] || l.slice(5)) : S.f.tag && i.g.includes(S.f.tag) ? " · " + esc(C.tagLabel(S.f.tag)) : ""; };
  let pills = up.map(i => `<span class="pill p-${i.k === "rorate" ? "ev" : i.k === "prayer" ? "ador" : i.k}">${i.t ? `<span class="t">${showT(i.t)}</span>` : ""}${i.k === "mass" ? "mise" + lang(i) : i.k === "rorate" ? "rorate" : i.k === "conf" ? "gyónás" : esc(i.what.length > 24 ? i.what.slice(0, 22) + "…" : i.what)}</span>`).join("");
  if (!pills) pills = !hasSchedule(r.c) && !di.feastMode ? `<span class="pill p-closed">Még nincs feltöltött időpont</span>`
    : `<span class="pill p-closed">${isToday() ? "Ma már nincs több alkalom" : "Nincs alkalom ezen a napon"}</span>`;
  const os = isToday() ? (r.os || openState(r.c, now())) : null;
  const osPill = os && os.label ? `<span class="pill ${os.known && os.open ? "p-open" : "p-closed"}">${os.label}</span>` : "";
  const feast = di.feastMode ? `<span class="pill p-ev">ünnepi rend</span>` : "";
  const rite = r.c.rite === "gk" ? `<span class="pill p-rite">görögkatolikus</span>` : "";
  const where = [r.c.city, r.c.addr].filter(Boolean).join(", ");
  return `<li><button class="card" data-id="${r.c.id}" aria-current="${S.sel === r.c.id}">
    <div class="card-top"><div><h3>${esc(r.c.name)}</h3><div class="where">${esc(where)}</div></div><span class="dist">${r.dist < 1 ? "<1" : Math.round(r.dist)} km</span></div>
    <div class="next">${osPill}${feast}${rite}${pills}</div></button></li>`;
}
function renderList() {
  if (S.loading || S.error) { panel.innerHTML = `<div class="empty pad">${S.error ? esc(S.error) : "Templomok betöltése…"}</div>`; return; }
  const ctx = dayContext(selDate()), rows = filtered(), shown = rows.slice(0, LIST_LIMIT), more = rows.length - shown.length;
  panel.innerHTML = controlsHTML(ctx) + `<ul class="list pad">${shown.map(cardHTML).join("") || `<li class="empty">Nincs a szűrőknek megfelelő templom. Próbálj másik napot vagy kapcsolj ki egy szűrőt.</li>`}
    ${more > 0 ? `<li class="empty">További ${more.toLocaleString("hu-HU")} templom. Írj be egy települést, vagy válassz másik kiindulópontot.</li>` : ""}</ul>`;
  let nConf = 0; for (const r of rows) if (r.di.hasConf) nConf++;
  $("#summary").textContent = `${rows.length.toLocaleString("hu-HU")} templom · ${nConf} helyen gyóntatnak ${isToday() ? "ma" : "aznap"} · ${ctx.summer ? "nyári" : "téli"} időszámítás · távolság: ${S.origin}`;
  bindControls(); drawMarkers(rows); renderNearest(rows); updateFilterBadge();
}
let searchTimer;
function bindControls() {
  $("#q").addEventListener("input", e => {
    S.q = e.target.value; clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { const pos = $("#q").selectionStart; renderList(); const n = $("#q"); n.focus(); try { n.setSelectionRange(pos, pos); } catch (_) { } }, 150);
  });
  $("#day").addEventListener("change", e => { S.dayOffset = +e.target.value; if (!isToday()) S.f.open = false; if (!C.inAdvent(selDate())) S.f.rorate = false; render(); });
  $("#origin").addEventListener("change", e => {
    if (e.target.value === "__me") return locateMe();
    S.origin = e.target.value; try { localStorage.setItem("harangszo", JSON.stringify({ origin: S.origin })); } catch (_) { } render();
  });
  $("#tagf")?.addEventListener("change", e => { S.f.tag = e.target.value; renderList(); });
  panel.querySelectorAll(".chip").forEach(b => b.addEventListener("click", () => { S.f[b.dataset.f] = !S.f[b.dataset.f]; renderList(); }));
  panel.querySelector(".list").addEventListener("click", e => { const b = e.target.closest(".card"); if (b) select(+b.dataset.id); });
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
    const extra = [s.w ? weeksText(s.w, dow) : "", everyText(s, dow), s.k === "prayer" ? "" : s.n].filter(Boolean).join(" · ");
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
    : ["advent", "lent", "eastertide"].includes(s.p) ? "az egyházi év szerint" : rangeText(C.PERIOD_INFO[s.p].range || "");
  const names = key => key.split(",").filter(Boolean).map(p => SEASON_NAME[p]).join(" és ") || "–";
  const active = [...groups.values()].filter(s => nowKey.split(",").includes(s.p));
  const list = [...new Map([...groups.values()].map(s => [s.p, s])).values()].map(s => `${SEASON_NAME[s.p]}: ${describe(s)}`).join(" · ");
  const az = w => /^[aáeéiíoóöőuúüű]/i.test(w) ? "az" : "a";
  return `<p class="muted season">${active.length ? `Most ${az(names(nowKey))} <b>${names(nowKey)}</b> miserend érvényes.` : ""}${change ? ` Következő váltás: ${change.getFullYear() !== ctx.date.getFullYear() ? change.getFullYear() + ". " : ""}${shortDate(change)} (${names(activeOn(change))} rend).` : ""}<br>${esc(list)}</p>`;
}
// The coming days from the parish's own weekly schedule, day by day.
function datedWeekHTML(c) {
  const today = ymd(now()), until = ymd(C.addDays(now(), 7));
  const days = [...new Set((c.dated || []).map(d => d.date))].filter(d => d >= today && d < until).sort();
  if (!days.length) return "";
  const url = c.dated.find(d => d.url)?.url;
  const rows = days.map(day => {
    const dt = new Date(day + "T12:00"), list = c.dated.filter(d => d.date === day).sort((a, b) => mins(a.t) - mins(b.t));
    const ms = list.filter(i => i.k === "mass" || i.k === "rorate").map(i => showT(i.t)).join(" · ");
    const cs = list.filter(i => i.k === "conf").map(i => range(i.t, i.u)).join(" · ");
    const other = list.filter(i => i.k === "prayer" || i.k === "ador").map(i => `${showT(i.t)} ${i.n || (i.k === "ador" ? "szentségimádás" : "")}`).join(" · ");
    return `<tr class="${day === today ? "today" : ""}"><th scope="row">${DAYN[dt.getDay()].slice(0, 3)}.<br><small>${shortDate(dt)}</small></th><td><span class="wt"><span class="t">${ms || "–"}</span></span>${cs ? `<span class="wt"><small>gyónás: ${esc(cs)}</small></span>` : ""}${other ? `<span class="wt"><small>${esc(other)}</small></span>` : ""}</td></tr>`;
  }).join("");
  return `<div class="sec"><h4>A következő napok · a templom heti miserendje szerint</h4><div class="week"><table><thead><tr><th scope="col">Nap</th><th scope="col">Szentmise</th></tr></thead><tbody>${rows}</tbody></table></div>${url ? `<p class="muted source">Forrás: <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">a templom heti miserendje (PDF)</a></p>` : ""}</div>`;
}
function rorateHTML(c) {
  const rr = c.svc.filter(s => isRegular(s) && s.k === "rorate");
  if (!rr.length) return "";
  const y = now().getMonth() === 11 && now().getDate() > 24 ? now().getFullYear() + 1 : now().getFullYear();
  const s = C.adventStart(y);
  return `<div class="sec"><h4>Rorate · advent idején (${shortDate(s)} – dec. 24.)</h4><div class="dayline">${rr.sort((a, b) => mins(a.t) - mins(b.t)).map(r =>
    `<div class="slot"><span class="t">${showT(r.t)}</span><div><div class="k k-ev">${daysText(r.d)}</div>${r.n ? `<div class="what">${esc(r.n)}</div>` : ""}</div></div>`).join("")}</div></div>`;
}
function feastScheduleHTML(c) {
  const keys = new Set([...c.feastSunday, ...c.svc.filter(s => s.feast).map(s => s.feast)]);
  if (!keys.size) return "";
  const from = now(), limit = C.addDays(from, 120);
  const list = [...keys].map(k => ({ k, d: C.nextFeastDate(k, from) })).filter(x => x.d && x.d <= limit).sort((a, b) => a.d - b.d);
  if (!list.length) return "";
  return `<div class="sec"><h4>Ünnepi miserend</h4><div class="ev-list">${list.map(({ k, d }) => {
    const di = dayInfo(c, dayContext(d));
    const times = di.items.filter(i => i.k !== "ev").map(i => `${range(showT(i.t), i.end)} ${i.k === "mass" ? "mise" : i.k === "conf" ? "gyónás" : i.k === "ador" ? "szentségimádás" : i.k === "prayer" ? esc(i.what) : "rorate"}${i.n ? " (" + esc(i.n) + ")" : ""}`).join(" · ");
    return `<div class="ev"><div class="date"><b>${d.getDate()}</b><small>${MON[d.getMonth()]}</small></div><div><h5>${esc(C.FEAST_BY_KEY[k].name)}</h5>
      <div class="muted">${DAYN[d.getDay()]}${di.feastMode === "sunday" ? " · vasárnapi rend szerint" : ""}</div><div class="feast-times">${times || "–"}</div></div></div>`;
  }).join("")}</div></div>`;
}
function noteHTML(c) {
  const lines = (c.note || "").split("\n").filter(Boolean);
  const src = c.source ? `<p class="muted source">Forrás: ${c.sourceUrl ? `<a href="${esc(c.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(SOURCES[c.source] || c.source)}</a>` : esc(SOURCES[c.source] || c.source)}${c.updated ? ` · frissítve ${longDate(c.updated)}` : ""}</p>` : "";
  if (!lines.length && !src) return "";
  // Lines ending in ":" are headings of the list that follows them.
  const body = lines.map(l => /:$/.test(l) ? `<p class="note-h">${linkify(l)}</p>` : `<p>${linkify(l)}</p>`).join("");
  return `<div class="sec"><h4>Megjegyzés a miserendhez</h4>${body ? `<div class="schednote">${body}</div>` : ""}${src}</div>`;
}
function renderDetail() {
  const c = BY_ID.get(S.sel); if (!c) { S.sel = null; return renderList(); }
  const ctx = dayContext(selDate()), di = dayInfoCached(c, ctx), m = now().getHours() * 60 + now().getMinutes();
  const os = openState(c, now());
  const label = k => k === "mass" ? massWord(c) : k === "conf" ? "Gyóntatás" : k === "ador" ? "Szentségimádás" : k === "rorate" ? "Rorate" : k === "prayer" ? "Imaóra, ájtatosság" : "Esemény";
  const slots = di.items.map(i => {
    const past = isToday() && i.t && mins(i.end || i.t) < m;
    return `<div class="slot ${past ? "past" : ""}"><span class="t">${showT(i.t) || "–"}${i.end ? "–<br>" + i.end : ""}</span><div><div class="k k-${i.k === "rorate" ? "ev" : i.k}">${label(i.k)}</div><div class="what">${i.k === "ev" || i.k === "prayer" ? esc(i.what) : esc(i.n)}${tagsHTML(i.g)}</div>${i.k === "ev" && i.n ? `<div class="note">${esc(i.n)}</div>` : ""}</div></div>`;
  }).join("") || `<div class="slot"><span class="t">–</span><div class="what muted">${hasSchedule(c) ? "Nincs meghirdetett alkalom ezen a napon." : "Ehhez a templomhoz még nincs feltöltött időpont. Ha tudod a miserendet, küldd be lent."}</div></div>`;
  const evs = c.ev.filter(e => e.date >= ymd(now())).sort((a, b) => a.date.localeCompare(b.date)).map(e => {
    const dt = new Date(e.date + "T12:00");
    return `<div class="ev"><div class="date"><b>${dt.getDate()}</b><small>${MON[dt.getMonth()]}</small></div><div><h5>${esc(e.title)}</h5><div class="muted">${DAYN[dt.getDay()]}${e.t ? ", " + e.t : ""}${e.n ? " · " + esc(e.n) : ""}</div></div></div>`;
  }).join("") || `<p class="muted">Nincs meghirdetett esemény. Ha tudsz egyről, küldd be lent.</p>`;
  const dir = `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lon}`;
  const where = [c.city, c.addr].filter(Boolean).join(", ");
  const contact = [c.web ? `<a href="${esc(/^https?:/i.test(c.web) ? c.web : "https://" + c.web)}" target="_blank" rel="noopener noreferrer">Weboldal</a>` : "", c.phone ? `<span>${esc(c.phone)}</span>` : ""].filter(Boolean).join(" · ");
  const feastBar = di.feastMode === "dated" ? `<div class="feastbar">A templom heti miserendje szerint${di.feast ? " · " + esc(di.feast) : ""}${di.datedUrl ? ` · <a href="${esc(di.datedUrl)}" target="_blank" rel="noopener noreferrer">forrás</a>` : ""}</div>`
    : di.feast ? `<div class="feastbar">Ünnepi miserend · ${esc(di.feast)}${di.feastMode === "sunday" ? " (vasárnapi rend szerint)" : ""}</div>` : "";
  panel.innerHTML = `<div class="detail pad">
    <button class="back" id="back">${S.tab === "map" && !isDesktop() ? "✕ Bezárás" : "← Vissza a listához"}</button>
    <div class="d-head">
      <div class="next">${os.label ? `<span class="pill ${os.known && os.open ? "p-open" : "p-closed"}">${os.label}</span>` : ""}<span class="pill p-rite">${riteName(c)}</span></div>
      <h2>${esc(c.name)}</h2>
      <div class="where">${esc(where)} · ${kmText(distOf(c))} (${esc(S.origin)})</div>
      ${(() => { const nm = nextOf({ items: di.items.filter(i => i.k === "mass" || i.k === "rorate") }), n = nm.k ? nm : nextOf(di); return n.k ? `<div class="hero-next"><span class="micro">${n.k === "conf" ? "Következő gyóntatás" : "Következő " + (c.rite === "gk" ? "liturgia" : "mise")}${isToday() ? "" : " · " + esc(dayLabel(S.dayOffset).toLowerCase())}</span><b class="hero-t k-${n.cls === "conf" ? "conf" : "mass"}">${esc(n.t)}</b></div>` : ""; })()}
      ${contact ? `<div class="where">${contact}</div>` : ""}
      ${c.approx ? `<div class="approx">A templom helye a térképen hozzávetőleges (a település közepe). Útvonaltervezés előtt ellenőrizd a címet.</div>` : ""}
    </div>
    <div class="actions"><a class="btn primary" href="${dir}" target="_blank" rel="noopener noreferrer">Útvonal a Google Térképen</a><button class="btn" id="go-suggest">Javítás beküldése</button></div>
    <div class="sec"><h4>${dayLabel(S.dayOffset)}</h4>${feastBar}<div class="dayline">${slots}</div></div>
    ${datedWeekHTML(c)}
    ${c.svc.some(s => !s.feast) || c.hours.length ? `<div class="sec"><h4>${(c.dated || []).length ? "Általános heti rend" : "Heti rend"}</h4><div class="week"><table>${weekTable(c, ctx)}</table></div>${seasonNote(c, ctx)}</div>` : ""}
    ${noteHTML(c)}
    ${feastScheduleHTML(c)}
    ${rorateHTML(c)}
    <div class="sec"><h4>Közelgő események</h4><div class="ev-list">${evs}</div></div>
    <div class="sec" id="suggest-sec"><h4>Pontosítás vagy új időpont</h4>${suggestForm()}</div>
  </div>`;
  $("#back").addEventListener("click", () => { S.sel = null; if (S.tab === "map" && !isDesktop()) setSheet("closed"); render(); });
  $("#go-suggest").addEventListener("click", () => { $("#suggest-sec").scrollIntoView({ behavior: "smooth", block: "start" }); setTimeout(() => $("#s-text")?.focus(), 300); });
  bindSuggest(c);
  drawMarkers(lastRows.length ? lastRows : filtered());
  panel.scrollTop = 0;
}

/* ---------- Suggestions: database when live, otherwise a pre-filled GitHub issue ---------- */
const TYPES = { conf: "Gyóntatási időpont", mass: "Mise időpont", hours: "Nyitvatartás", event: "Esemény", place: "Hely vagy egyéb" };
function suggestForm() {
  return `<form class="suggest" id="s-form" novalidate>
    <label for="s-type">Mit javítanál?<select id="s-type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
    <label for="s-text">Leírás<textarea id="s-text" maxlength="600" placeholder="Pl. Szerdánként 17:00–18:00 között is gyóntatnak, a hirdetőtábla szerint."></textarea></label>
    ${LIVE ? `<label for="s-contact">E-mail vagy telefon (nem kötelező, csak ha visszakérdeznénk)<input id="s-contact" type="text" maxlength="200" autocomplete="email"></label>` : ""}
    <div class="row"><button class="btn primary" type="submit" id="s-send">Javaslat beküldése</button><span class="status" id="s-status" role="status"></span></div>
    <p class="muted" style="margin:0">${LIVE ? "A javaslatot egy szerkesztő ellenőrzi, mielőtt megjelenik." : "A beküldés egy GitHub-hibajegyet nyit meg kitöltve (GitHub-fiók kell hozzá)."}</p>
  </form>`;
}
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

/* ---------- Map ---------- */
/* The map never draws every church. It shows the most important churches inside the current view, up to a budget
   that fits the screen. Zooming in shrinks the view, so smaller churches appear; at street level everything shows.
   Importance = the church's score (cathedral, basilica, pilgrimage church, Wikipedia entry, city… or an editor's
   override) plus a bonus for churches with times entered, and for confession or Mass on the chosen day. */
const HU_BOUNDS = { s: 45.7, w: 16.1, n: 48.6, e: 22.9 };
const SHOW_ALL_ZOOM = 14, LABEL_ZOOM = 12.5;
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const OSM_DATA_CREDIT = 'Templomhelyek: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const markerBudget = () => { const el = $("#map"); const a = (el.clientWidth || 800) * (el.clientHeight || 500); return Math.max(40, Math.min(180, Math.round(a / 4500))); };

// Markers are created once per church on first show; each draw only adds/removes the ones whose visibility
// changed and re-styles the ones whose colour or selection changed.
function makeDiffer(create, restyle, addMany, removeMany) {
  const cache = new Map(); let shown = new Set();
  return list => {
    const next = new Set(), toAdd = [];
    for (const p of list) {
      let e = cache.get(p.c.id);
      if (!e) { e = { mk: create(p.c), sig: "" }; cache.set(p.c.id, e); }
      const sig = p.cls + "|" + (p.label || "") + (p.dot ? "." : "") + (p.sel ? "*" : "");
      if (e.sig !== sig) { restyle(e.mk, p); e.sig = sig; }
      next.add(p.c.id);
      if (!shown.has(p.c.id)) toAdd.push(e.mk);
    }
    const toRemove = [];
    for (const id of shown) if (!next.has(id)) toRemove.push(cache.get(id).mk);
    if (toRemove.length) removeMany(toRemove);
    if (toAdd.length) addMany(toAdd);
    shown = next;
  };
}
function leafletView() {
  const map = L.map("map", { minZoom: 6, maxZoom: 18, zoomSnap: .25, zoomControl: false, maxBounds: [[44.9, 15.3], [49.4, 23.8]] });
  // Light or dark base map with the site's theme (CARTO basemaps on OpenStreetMap data).
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const tiles = () => L.tileLayer(`https://{s}.basemaps.cartocdn.com/${dark.matches ? "dark_all" : "rastertiles/voyager"}/{z}/{x}/{y}{r}.png`, { maxZoom: 19, subdomains: "abcd",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-közreműködők &copy; <a href="https://carto.com/attributions">CARTO</a>' });
  let base = tiles().addTo(map);
  dark.addEventListener?.("change", () => { map.removeLayer(base); base = tiles().addTo(map); });
  $("#zoom-in").addEventListener("click", () => map.zoomIn()); $("#zoom-out").addEventListener("click", () => map.zoomOut());
  let meMk = null;
  map.fitBounds([[HU_BOUNDS.s, HU_BOUNDS.w], [HU_BOUNDS.n, HU_BOUNDS.e]]);
  const layer = L.layerGroup().addTo(map);
  const icons = {};
  const icon = p => { const k = p.cls + p.label + p.dot + p.sel; return icons[k] || (icons[k] = L.divIcon({ className: "mkicon", iconSize: [0, 0],
    html: p.dot ? `<div class="mkdot mk-${p.cls} ${p.sel ? "sel" : ""}"></div>` : `<div class="mkwrap ${p.sel ? "sel" : ""}"><span class="mk mk-${p.cls}">${esc(p.label)}</span></div>` })); };
  const draw = makeDiffer(
    c => { const mk = L.marker([c.lat, c.lon], { title: c.name, icon: icon({ cls: "none", label: "–", dot: true, sel: false }), keyboard: false }); mk.on("click", () => select(c.id)); return mk; },
    (mk, p) => { mk.setIcon(icon(p)); mk.setZIndexOffset(p.sel ? 1000 : Math.round(p.c.score) + (p.cls === "none" ? 0 : 200)); },
    arr => arr.forEach(m => layer.addLayer(m)),
    arr => arr.forEach(m => layer.removeLayer(m)));
  let resizeT; window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { map.invalidateSize(); queueMarkers(); }, 150); });
  map.on("moveend", () => queueMarkers());
  return {
    draw, ready: () => true,
    view() { const b = map.getBounds().pad(0.05); return { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast(), zoom: map.getZoom() }; },
    focus(lat, lon, z) { map.flyTo([lat, lon], Math.max(map.getZoom(), z), { duration: .5 }); },
    me(lat, lon) { if (meMk) meMk.setLatLng([lat, lon]); else meMk = L.marker([lat, lon], { icon: L.divIcon({ className: "mkicon", iconSize: [0, 0], html: '<div class="me-dot"></div>' }), interactive: false, zIndexOffset: 2000 }).addTo(map); }
  };
}
// Google Maps in the same look as the Leaflet map: muted light or dark style, no Google buttons, time pills as markers.
const GM_LIGHT = [{ featureType: "poi", stylers: [{ visibility: "off" }] }, { featureType: "transit", stylers: [{ visibility: "off" }] },
  { elementType: "geometry", stylers: [{ saturation: -60 }] }, { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#c9d6e6" }] }, { featureType: "landscape", elementType: "geometry", stylers: [{ color: "#f1f0ec" }] }];
const GM_DARK = [{ featureType: "poi", stylers: [{ visibility: "off" }] }, { featureType: "transit", stylers: [{ visibility: "off" }] },
  { elementType: "geometry", stylers: [{ color: "#1b1f27" }] }, { elementType: "labels.text.fill", stylers: [{ color: "#8b94a6" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#11141a" }] }, { featureType: "road", elementType: "geometry", stylers: [{ color: "#2b313d" }] },
  { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] }, { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#363d4b" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0d1520" }] }, { featureType: "administrative", elementType: "geometry.stroke", stylers: [{ color: "#3a4253" }] }];
const pillSVG = (fill, ink, ring, label, sel) => {
  const w = Math.max(40, 12 + label.length * 7.4), h = 24, W = w + 8, H = h + 8;
  return { url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${sel ? `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="${H / 2 - 1}" fill="none" stroke="#c9971c" stroke-width="3"/>` : ""}
    <rect x="4" y="4" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" stroke="${ring}" stroke-width="2"/>
    <text x="${W / 2}" y="${H / 2 + 4}" text-anchor="middle" font-family="IBM Plex Mono,Menlo,monospace" font-size="11" font-weight="600" fill="${ink}">${label.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text></svg>`), w: W, h: H };
};
const dotSVG = (fill, ring, sel) => "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">${sel ? '<circle cx="10" cy="10" r="9" fill="none" stroke="#c9971c" stroke-width="3"/>' : ""}<circle cx="10" cy="10" r="6" fill="${fill}" stroke="${ring}" stroke-width="2"/></svg>`);
function googleView() {
  let gmap = null, pendingFocus = null, draw = null, meMk = null;
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const pal = () => ({ mass: [css("--accent"), css("--on-accent")], conf: [css("--penance"), css("--on-penance")], none: [css("--mk-none-bg"), css("--mk-none-ink")], ring: css("--surface"), border: css("--border") });
  let colors = null, iconCache = {};
  const icon = p => {
    const k = p.cls + p.label + p.dot + p.sel; if (iconCache[k]) return iconCache[k];
    const [fill, ink] = colors[p.cls], ring = p.cls === "none" ? colors.border : colors.ring;
    if (p.dot) return iconCache[k] = { url: dotSVG(p.cls === "none" ? colors.border : fill, colors.ring, p.sel), scaledSize: new google.maps.Size(20, 20), anchor: new google.maps.Point(10, 10) };
    const sv = pillSVG(fill, ink, ring, p.label, p.sel);
    return iconCache[k] = { url: sv.url, scaledSize: new google.maps.Size(sv.w, sv.h), anchor: new google.maps.Point(sv.w / 2, sv.h / 2) };
  };
  window.__initGoogle = () => {
    colors = pal();
    gmap = new google.maps.Map(document.getElementById("map"), { center: { lat: 47.16, lng: 19.5 }, zoom: 7, disableDefaultUI: true, keyboardShortcuts: false,
      gestureHandling: "greedy", clickableIcons: false, backgroundColor: css("--land"), styles: dark.matches ? GM_DARK : GM_LIGHT,
      restriction: { latLngBounds: { north: 49.4, south: 44.9, west: 15.3, east: 23.8 } } });
    gmap.fitBounds({ north: HU_BOUNDS.n, south: HU_BOUNDS.s, west: HU_BOUNDS.w, east: HU_BOUNDS.e });
    dark.addEventListener?.("change", () => { gmap.setOptions({ styles: dark.matches ? GM_DARK : GM_LIGHT }); colors = pal(); iconCache = {}; queueMarkers(); });
    draw = makeDiffer(
      c => { const mk = new google.maps.Marker({ position: { lat: c.lat, lng: c.lon }, title: c.name, optimized: true }); mk.addListener("click", () => select(c.id)); return mk; },
      (mk, p) => { mk.setIcon(icon(p)); mk.setZIndex(p.sel ? 1000 : Math.round(p.c.score) + (p.cls === "none" ? 0 : 200)); },
      arr => arr.forEach(m => m.setMap(gmap)),
      arr => arr.forEach(m => m.setMap(null)));
    gmap.addListener("idle", () => queueMarkers());
    if (pendingFocus) api.focus(...pendingFocus);
  };
  $("#zoom-in").addEventListener("click", () => gmap && gmap.setZoom(gmap.getZoom() + 1)); $("#zoom-out").addEventListener("click", () => gmap && gmap.setZoom(gmap.getZoom() - 1));
  window.gm_authFailure = () => { $("#notice").innerHTML = "<b>Térképhiba.</b> A Google Maps kulcs nem érvényes ehhez a címhez. Ellenőrizd a kulcs webhely-korlátozását."; };
  const s = document.createElement("script");
  s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(MAPS_KEY)}&callback=__initGoogle&language=hu&region=HU&loading=async`;
  s.async = true; document.head.appendChild(s);
  const api = {
    draw: list => draw && draw(list), ready: () => !!(draw && gmap.getBounds()),
    view() { const b = gmap.getBounds(), ne = b.getNorthEast(), sw = b.getSouthWest(), dy = (ne.lat() - sw.lat()) * .05, dx = (ne.lng() - sw.lng()) * .05;
      return { s: sw.lat() - dy, w: sw.lng() - dx, n: ne.lat() + dy, e: ne.lng() + dx, zoom: gmap.getZoom() }; },
    focus(lat, lon, z) { if (!gmap) { pendingFocus = [lat, lon, z]; return; } gmap.panTo({ lat, lng: lon }); if (gmap.getZoom() < z) gmap.setZoom(z); },
    me(lat, lon) { if (!gmap) return; const pos = { lat, lng: lon }; if (meMk) meMk.setPosition(pos); else meMk = new google.maps.Marker({ position: pos, map: gmap, clickable: false, zIndex: 2000,
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: colors.mass[0], fillOpacity: 1, strokeColor: "#fff", strokeWeight: 3 } }); }
  };
  return api;
}
const MapView = MAPS_KEY ? googleView() : (typeof L !== "undefined" ? leafletView() : { draw() { }, ready: () => false, view() { }, focus() { } });
if (!MAPS_KEY && typeof L === "undefined") $("#map").innerHTML = '<p style="padding:16px;color:var(--ink-3)">A térkép nem töltődött be. A lista ettől még használható.</p>';

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
  const v = MapView.view(), budget = markerBudget(), inView = [];
  for (const r of mapRows) { const c = r.c; if (c.lat >= v.s && c.lat <= v.n && c.lon >= v.w && c.lon <= v.e) inView.push(r); }
  let shown = inView;
  if (v.zoom < SHOW_ALL_ZOOM && inView.length > budget) {
    const rank = r => r.c.score + (r.di.hasConf ? 8 : 0) + (r.di.hasMass ? 5 : 0);
    shown = inView.sort((a, b) => rank(b) - rank(a)).slice(0, budget);
  }
  // Zoomed in: a pill with the next time; zoomed out: a coloured dot.
  const dot = v.zoom < LABEL_ZOOM;
  const list = shown.map(r => { const n = nextOf(r.di); return { c: r.c, cls: n.cls, label: n.t, dot, sel: S.sel === r.c.id }; });
  if (S.sel && !list.some(p => p.sel)) { const c = BY_ID.get(S.sel); if (c) { const n = nextOf(dayInfoCached(c, dayContext(selDate()))); list.push({ c, cls: n.cls, label: n.t, dot, sel: true }); } }
  MapView.draw(list);
  const hidden = inView.length - shown.length, hint = $("#maphint");
  if (hint) { hint.hidden = hidden <= 0; if (hidden > 0) hint.textContent = `Kiemelt templomok: ${shown.length} / ${inView.length.toLocaleString("hu-HU")} ebben a nézetben. Nagyíts a többiért.`; }
}
function select(id) {
  S.sel = id;
  const c = BY_ID.get(id);
  if (c) MapView.focus(c.lat, c.lon, 15);
  render();
  if (S.sheet === "closed" || isDesktop()) setSheet(isDesktop() ? "full" : "peek");
}

/* ---------- Boot ---------- */
function render() { S.sel ? renderDetail() : renderList(); }
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
  }).catch(() => { if (S.loading) { S.loading = false; S.error = "Nem sikerült betölteni a templomokat. Frissítsd az oldalt egy kicsit később."; render(); } });
}
setSheet(S.sheet); render(); boot();
setInterval(() => { if (!S.loading && isToday() && !typing()) render(); }, 60000);
