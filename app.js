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
const KIND = { mass: "mass", confession: "conf", adoration: "ador", rorate: "rorate" };
function fromSample(c) {
  const svc = [
    ...c.mass.map(m => ({ k: "mass", d: m.d, t: m.t, u: null, n: m.n, p: m.p || "all", feast: null })),
    ...c.conf.map(m => ({ k: "conf", d: m.d, t: m.f, u: m.u, n: m.n, p: m.p || "all", feast: null })),
    ...(c.ador || []).map(m => ({ k: "ador", d: m.d, t: m.f, u: m.u, n: m.n, p: "all", feast: null })),
    ...(c.rorate || []).map(m => ({ k: "rorate", d: m.d, t: m.t, u: null, n: m.n, p: "all", feast: null })),
    ...Object.entries(c.feasts || {}).flatMap(([key, rows]) => rows.map(m => ({ k: m.k, d: [], t: m.t, u: m.u || null, n: m.n, p: "all", feast: key }))),
  ];
  return { id: c.id, name: c.name, city: c.city, addr: c.addr, rite: c.rite, lat: c.lat, lon: c.lon,
    onlyServices: !c.hours, hours: c.hours || [], svc, feastSunday: c.feastSunday || [], ev: c.ev };
}
function fromDb(c) {
  return { id: c.id, name: c.name, city: c.city || "", addr: c.address || "", rite: c.rite, lat: c.lat, lon: c.lon,
    web: c.website, phone: c.phone, onlyServices: !!c.open_only_services,
    hours: (c.hours || []).map(h => ({ days: h.days, o: h.opens, c: h.closes })),
    svc: (c.services || []).map(s => ({ k: KIND[s.kind] || "mass", d: s.days || [], t: s.start, u: s.end || null, n: s.note, p: s.period || "all", feast: s.feast || null })),
    feastSunday: c.feast_sunday || [],
    ev: (c.events || []).map(e => ({ date: e.date, t: e.start || "", title: e.title, n: e.note })) };
}
function setChurches(list) {
  CHURCHES = list;
  BY_ID = new Map(list.map(c => [c.id, c]));
  for (const c of list) c.key = fold(c.name + " " + c.city + " " + c.addr);
  dayCache.clear(); distCache.origin = null;
}
const readCache = () => { try { return localStorage.getItem(CACHE_KEY); } catch (e) { return null; } };
const writeCache = text => { try { if (text.length < 4.5e6) localStorage.setItem(CACHE_KEY, text); } catch (e) { } };
async function fetchLive() {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/public_data`, { method: "POST", headers: { ...SB_HEADERS, "Content-Type": "application/json" }, body: "{}" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}

/* ---------- Schedule for one church on one day ---------- */
const hasSchedule = c => c.svc.some(s => !s.feast);
const isRegular = s => !s.feast;
function dayContext(date) {
  return { date, dow: date.getDay(), key: ymd(date), summer: C.isSummerTime(date), advent: C.inAdvent(date), feasts: C.feastsOn(date) };
}
function seasonOk(s, ctx) { return s.p === "all" || (s.p === "summer") === ctx.summer; }
function dayInfo(c, ctx) {
  let rows, feast = null, feastMode = null;
  const custom = ctx.feasts.length ? c.svc.filter(s => s.feast && ctx.feasts.includes(s.feast)) : [];
  const sundayFeast = ctx.feasts.find(k => c.feastSunday.includes(k));
  if (custom.length) { rows = custom; feast = C.FEAST_BY_KEY[custom[0].feast]?.name; feastMode = "custom"; }
  else if (sundayFeast) { rows = c.svc.filter(s => isRegular(s) && s.k !== "rorate" && seasonOk(s, ctx) && s.d.includes(0)); feast = C.FEAST_BY_KEY[sundayFeast]?.name; feastMode = "sunday"; }
  else rows = c.svc.filter(s => isRegular(s) && seasonOk(s, ctx) && s.d.includes(ctx.dow) && (s.k !== "rorate" || ctx.advent));
  const items = rows.map(s => ({ k: s.k, t: s.t, end: s.k === "mass" || s.k === "rorate" ? null : s.u, n: s.n,
    what: s.k === "mass" ? massWord(c) : s.k === "rorate" ? "Rorate" : s.k === "conf" ? "Gyóntatás" : "Szentségimádás" }));
  for (const e of c.ev) if (e.date === ctx.key) items.push({ k: "ev", t: e.t, end: null, what: e.title, n: e.n });
  items.sort((a, b) => mins(a.t) - mins(b.t));
  return { items, feast, feastMode,
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
const S = { q: "", dayOffset: 0, origin: "Budapest", f: { open: false, mass: false, conf: false, ev: false, rorate: false }, sel: null, loading: true, error: "" };
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
    <div class="chips" role="group" aria-label="Szűrők">
      ${chip("conf", "conf", "Gyóntatás", "var(--penance)")}${chip("mass", "mass", "Mise", "var(--accent)")}${ctx.advent ? chip("rorate", "ev", "Rorate", "var(--gold)") : ""}${isToday() ? chip("open", "open", "Most nyitva", "var(--open)") : ""}${chip("ev", "ev", "Esemény a héten", "var(--gold)")}
    </div>
    ${feastNames ? `<div class="feastline">Ünnep: <b>${esc(feastNames)}</b>. Ahol a templom megadta, az ünnepi miserend látszik.</div>` : ""}
    <div class="summary" id="summary"></div>
  </div>`;
}
function cardHTML(r) {
  const di = r.di, up = upcoming(di.items).filter(i => i.k !== "ador").slice(0, 3);
  let pills = up.map(i => `<span class="pill p-${i.k === "rorate" ? "ev" : i.k}">${i.t ? `<span class="t">${showT(i.t)}</span>` : ""}${i.k === "mass" ? "mise" : i.k === "rorate" ? "rorate" : i.k === "conf" ? "gyónás" : esc(i.what.length > 24 ? i.what.slice(0, 22) + "…" : i.what)}</span>`).join("");
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
  bindControls(); drawMarkers(rows);
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
  panel.querySelectorAll(".chip").forEach(b => b.addEventListener("click", () => { S.f[b.dataset.f] = !S.f[b.dataset.f]; renderList(); }));
  panel.querySelector(".list").addEventListener("click", e => { const b = e.target.closest(".card"); if (b) select(+b.dataset.id); });
}
function locateMe() {
  $("#summary").textContent = "Helymeghatározás…";
  navigator.geolocation.getCurrentPosition(p => {
    ORIGINS["Saját helyzetem"] = [p.coords.latitude, p.coords.longitude]; S.origin = "Saját helyzetem";
    MapView.focus(p.coords.latitude, p.coords.longitude, 12); render();
  }, () => { render(); $("#summary").textContent = "A helyzeted nem érhető el. Engedélyezd a böngészőben, vagy válassz várost."; }, { timeout: 10000, maximumAge: 300000 });
}

/* ---------- Rendering: detail ---------- */
function weekTable(c, ctx) {
  const today = now().getDay();
  const reg = c.svc.filter(s => isRegular(s) && s.k !== "rorate" && seasonOk(s, ctx));
  return [1, 2, 3, 4, 5, 6, 0].map(dow => {
    const ms = reg.filter(s => s.k === "mass" && s.d.includes(dow)).map(s => s.t).sort((a, b) => mins(a) - mins(b)).map(showT).join(", ") || "–";
    const cs = reg.filter(s => s.k === "conf" && s.d.includes(dow)).map(s => range(s.t, s.u)).join(", ");
    return `<tr class="${dow === today ? "today" : ""}"><th scope="row">${DAYN[dow].slice(0, 3)}.</th><td>${ms}${cs ? `<br><span class="c">gyón. ${cs}</span>` : ""}</td><td>${hoursText(c, dow)}</td></tr>`;
  }).join("");
}
function seasonNote(c, ctx) {
  if (!c.svc.some(s => isRegular(s) && s.p !== "all")) return "";
  const next = C.nextClockChange(ctx.date);
  return `<p class="muted season">${ctx.summer ? "Nyári" : "Téli"} miserend van érvényben. ${next ? `${next.getFullYear()}. ${shortDate(next)} -tól a ${ctx.summer ? "téli" : "nyári"} rend szerint változik.` : ""}</p>`;
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
    const times = di.items.filter(i => i.k !== "ev").map(i => `${range(showT(i.t), i.end)} ${i.k === "mass" ? "mise" : i.k === "conf" ? "gyónás" : i.k === "ador" ? "szentségimádás" : "rorate"}${i.n ? " (" + esc(i.n) + ")" : ""}`).join(" · ");
    return `<div class="ev"><div class="date"><b>${d.getDate()}</b><small>${MON[d.getMonth()]}</small></div><div><h5>${esc(C.FEAST_BY_KEY[k].name)}</h5>
      <div class="muted">${DAYN[d.getDay()]}${di.feastMode === "sunday" ? " · vasárnapi rend szerint" : ""}</div><div class="feast-times">${times || "–"}</div></div></div>`;
  }).join("")}</div></div>`;
}
function renderDetail() {
  const c = BY_ID.get(S.sel); if (!c) { S.sel = null; return renderList(); }
  const ctx = dayContext(selDate()), di = dayInfoCached(c, ctx), m = now().getHours() * 60 + now().getMinutes();
  const os = openState(c, now());
  const label = k => k === "mass" ? massWord(c) : k === "conf" ? "Gyóntatás" : k === "ador" ? "Szentségimádás" : k === "rorate" ? "Rorate" : "Esemény";
  const slots = di.items.map(i => {
    const past = isToday() && i.t && mins(i.end || i.t) < m;
    return `<div class="slot ${past ? "past" : ""}"><span class="t">${showT(i.t) || "–"}${i.end ? "–<br>" + i.end : ""}</span><div><div class="k k-${i.k === "rorate" ? "ev" : i.k}">${label(i.k)}</div><div class="what">${i.k === "ev" ? esc(i.what) : esc(i.n)}</div>${i.k === "ev" && i.n ? `<div class="note">${esc(i.n)}</div>` : ""}</div></div>`;
  }).join("") || `<div class="slot"><span class="t">–</span><div class="what muted">${hasSchedule(c) ? "Nincs meghirdetett alkalom ezen a napon." : "Ehhez a templomhoz még nincs feltöltött időpont. Ha tudod a miserendet, küldd be lent."}</div></div>`;
  const evs = c.ev.filter(e => e.date >= ymd(now())).sort((a, b) => a.date.localeCompare(b.date)).map(e => {
    const dt = new Date(e.date + "T12:00");
    return `<div class="ev"><div class="date"><b>${dt.getDate()}</b><small>${MON[dt.getMonth()]}</small></div><div><h5>${esc(e.title)}</h5><div class="muted">${DAYN[dt.getDay()]}${e.t ? ", " + e.t : ""}${e.n ? " · " + esc(e.n) : ""}</div></div></div>`;
  }).join("") || `<p class="muted">Nincs meghirdetett esemény. Ha tudsz egyről, küldd be lent.</p>`;
  const dir = `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lon}`;
  const where = [c.city, c.addr].filter(Boolean).join(", ");
  const contact = [c.web ? `<a href="${esc(/^https?:/i.test(c.web) ? c.web : "https://" + c.web)}" target="_blank" rel="noopener noreferrer">Weboldal</a>` : "", c.phone ? `<span>${esc(c.phone)}</span>` : ""].filter(Boolean).join(" · ");
  const feastBar = di.feast ? `<div class="feastbar">Ünnepi miserend · ${esc(di.feast)}${di.feastMode === "sunday" ? " (vasárnapi rend szerint)" : ""}</div>` : "";
  panel.innerHTML = `<div class="detail pad">
    <button class="back" id="back">← Vissza a listához</button>
    <div class="d-head">
      <div class="next">${os.label ? `<span class="pill ${os.known && os.open ? "p-open" : "p-closed"}">${os.label}</span>` : ""}<span class="pill p-rite">${riteName(c)}</span></div>
      <h2>${esc(c.name)}</h2>
      <div class="where">${esc(where)} · ${Math.round(distOf(c))} km (${esc(S.origin)})</div>
      ${contact ? `<div class="where">${contact}</div>` : ""}
    </div>
    <div class="actions"><a class="btn primary" href="${dir}" target="_blank" rel="noopener noreferrer">Útvonal a Google Térképen</a><button class="btn" id="go-suggest">Javítás beküldése</button></div>
    <div class="sec"><h4>${dayLabel(S.dayOffset)}</h4>${feastBar}<div class="dayline">${slots}</div></div>
    ${hasSchedule(c) || c.hours.length ? `<div class="sec"><h4>Heti rend</h4><div class="week"><table><tbody>${weekTable(c, ctx)}</tbody></table></div>${seasonNote(c, ctx)}</div>` : ""}
    ${feastScheduleHTML(c)}
    ${rorateHTML(c)}
    <div class="sec"><h4>Közelgő események</h4><div class="ev-list">${evs}</div></div>
    <div class="sec" id="suggest-sec"><h4>Pontosítás vagy új időpont</h4>${suggestForm()}</div>
  </div>`;
  $("#back").addEventListener("click", () => { S.sel = null; render(); });
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
const HU_BOUNDS = { s: 45.7, w: 16.1, n: 48.6, e: 22.9 };
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const pinSVG = (fill, sel) => "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="38" viewBox="0 0 30 38"><path d="M15 37C15 37 3 22 3 14a12 12 0 0 1 24 0c0 8-12 23-12 23z" fill="${fill}" stroke="${sel ? "#c9971c" : "#fff"}" stroke-width="${sel ? 3 : 2}"/><path d="M14 7h2v14h-2zM10 11h10v2H10z" fill="#fff"/></svg>`);
const OSM_DATA_CREDIT = 'Templomhelyek: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

// Shared diffing: markers are created once per church; each draw only adds/removes the ones whose
// visibility changed and re-styles the ones whose colour or selection changed.
function makeDiffer(create, restyle, addMany, removeMany, reset) {
  const cache = new Map(); let shown = new Set();
  return list => {
    const next = new Set(), toAdd = [], all = [];
    for (const p of list) {
      let e = cache.get(p.c.id);
      if (!e) { e = { mk: create(p.c), sig: "" }; cache.set(p.c.id, e); }
      const sig = p.cls + (p.sel ? "*" : "");
      if (e.sig !== sig) { restyle(e.mk, p); e.sig = sig; }
      next.add(p.c.id); all.push(e.mk);
      if (!shown.has(p.c.id)) toAdd.push(e.mk);
    }
    const toRemove = [];
    for (const id of shown) if (!next.has(id)) toRemove.push(cache.get(id).mk);
    // Many changes at once (a search or filter over thousands of churches): one bulk rebuild is far cheaper
    // than removing and adding markers one by one.
    if (toRemove.length + toAdd.length > 200 && reset) reset(all);
    else { if (toRemove.length) removeMany(toRemove); if (toAdd.length) addMany(toAdd); }
    shown = next;
  };
}
function leafletView() {
  const map = L.map("map", { minZoom: 6, maxZoom: 18, zoomSnap: .25, maxBounds: [[44.9, 15.3], [49.4, 23.8]], preferCanvas: true });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-közreműködők' }).addTo(map);
  map.fitBounds([[HU_BOUNDS.s, HU_BOUNDS.w], [HU_BOUNDS.n, HU_BOUNDS.e]]);
  const group = L.markerClusterGroup ? L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 55, chunkedLoading: true, removeOutsideVisibleBounds: true,
    animate: false, iconCreateFunction: cl => L.divIcon({ className: "", html: `<div class="cluster">${cl.getChildCount()}</div>`, iconSize: [36, 36] }) }) : L.layerGroup();
  map.addLayer(group);
  const icons = {};
  const icon = (cls, sel) => icons[cls + sel] || (icons[cls + sel] = L.divIcon({ className: "", html: `<div class="pin ${cls} ${sel ? "sel" : ""}"><i></i></div>`, iconSize: [26, 26], iconAnchor: [13, 26] }));
  const draw = makeDiffer(
    c => { const mk = L.marker([c.lat, c.lon], { title: c.name, icon: icon("dim", false) }); mk.on("click", () => select(c.id)); return mk; },
    (mk, p) => { mk.setIcon(icon(p.cls, p.sel)); mk.setZIndexOffset(p.sel ? 1000 : 0); },
    arr => group.addLayers ? group.addLayers(arr) : arr.forEach(m => group.addLayer(m)),
    arr => group.removeLayers ? group.removeLayers(arr) : arr.forEach(m => group.removeLayer(m)),
    arr => { group.clearLayers(); group.addLayers ? group.addLayers(arr) : arr.forEach(m => group.addLayer(m)); });
  let resizeT; window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => map.invalidateSize(), 150); });
  return { draw, focus(lat, lon, z) { map.flyTo([lat, lon], Math.max(map.getZoom(), z), { duration: .5 }); } };
}
function googleView() {
  let gmap = null, clusterer = null, pending = null, pendingFocus = null, draw = null, colors = null;
  window.__initGoogle = () => {
    gmap = new google.maps.Map(document.getElementById("map"), { center: { lat: 47.16, lng: 19.5 }, zoom: 7,
      restriction: { latLngBounds: { north: 49.4, south: 44.9, west: 15.3, east: 23.8 } }, mapTypeControl: false, streetViewControl: false, fullscreenControl: false, clickableIcons: false });
    gmap.fitBounds({ north: HU_BOUNDS.n, south: HU_BOUNDS.s, west: HU_BOUNDS.w, east: HU_BOUNDS.e });
    colors = { conf: css("--penance") || "#6a2e8c", mass: css("--accent") || "#23408e", dim: css("--ink-3") || "#7b8496" };
    const iconCache = {};
    const icon = (cls, sel) => iconCache[cls + sel] || (iconCache[cls + sel] = { url: pinSVG(colors[cls], sel), scaledSize: new google.maps.Size(30, 38), anchor: new google.maps.Point(15, 37) });
    const MC = window.markerClusterer?.MarkerClusterer;
    if (MC) clusterer = new MC({ map: gmap, markers: [], renderer: { render: ({ count, position }) => new google.maps.Marker({ position, zIndex: 900 + count,
      label: { text: String(count), color: "#fff", fontSize: "12px", fontWeight: "600" },
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 17, fillColor: colors.mass, fillOpacity: .9, strokeColor: "#fff", strokeWeight: 2 } }) } });
    draw = makeDiffer(
      c => { const mk = new google.maps.Marker({ position: { lat: c.lat, lng: c.lon }, title: c.name, optimized: true }); mk.addListener("click", () => select(c.id)); return mk; },
      (mk, p) => { mk.setIcon(icon(p.cls, p.sel)); mk.setZIndex(p.sel ? 1000 : 1); },
      arr => clusterer ? clusterer.addMarkers(arr, false) : arr.forEach(m => m.setMap(gmap)),
      arr => clusterer ? clusterer.removeMarkers(arr, false) : arr.forEach(m => m.setMap(null)),
      arr => { if (!clusterer) return; clusterer.clearMarkers(true); clusterer.addMarkers(arr, true); clusterer.render(); });
    if (pending) draw(pending); if (pendingFocus) api.focus(...pendingFocus);
  };
  window.gm_authFailure = () => { $("#notice").innerHTML = "<b>Térképhiba.</b> A Google Maps kulcs nem érvényes ehhez a címhez. Ellenőrizd a kulcs webhely-korlátozását."; };
  const s = document.createElement("script");
  s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(MAPS_KEY)}&callback=__initGoogle&language=hu&region=HU&loading=async`;
  s.async = true; document.head.appendChild(s);
  const api = {
    draw(list) { if (!draw) { pending = list; return; } draw(list); },
    focus(lat, lon, z) { if (!gmap) { pendingFocus = [lat, lon, z]; return; } gmap.panTo({ lat, lng: lon }); if (gmap.getZoom() < z) gmap.setZoom(z); }
  };
  return api;
}
const MapView = MAPS_KEY ? googleView() : (typeof L !== "undefined" ? leafletView() : { draw() { }, focus() { } });
if (!MAPS_KEY && typeof L === "undefined") $("#map").innerHTML = '<p style="padding:16px;color:var(--ink-3)">A térkép nem töltődött be. A lista ettől még használható.</p>';

let markerJob = null;
function drawMarkers(rows) {
  // Defer to after the list has painted so typing and filtering stay responsive; only the latest request runs.
  if (markerJob) (window.cancelIdleCallback || clearTimeout)(markerJob);
  const run = () => {
    markerJob = null;
    const list = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) { const r = rows[i]; list[i] = { c: r.c, cls: r.di.hasConf ? "conf" : r.di.hasMass ? "mass" : "dim", sel: S.sel === r.c.id }; }
    if (S.sel && !rows.some(r => r.c.id === S.sel)) { const c = BY_ID.get(S.sel); if (c) list.push({ c, cls: "mass", sel: true }); }
    MapView.draw(list);
  };
  markerJob = window.requestIdleCallback ? requestIdleCallback(run, { timeout: 300 }) : setTimeout(run, 60);
}
function select(id) {
  S.sel = id;
  const c = BY_ID.get(id);
  if (c) MapView.focus(c.lat, c.lon, 15);
  render();
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
render(); boot();
setInterval(() => { if (!S.loading && isToday() && !typing()) render(); }, 60000);
