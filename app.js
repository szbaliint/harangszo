"use strict";
/* Harangszó public site.
   Data: Supabase (public_data RPC) when configured in config.js, otherwise the sample file data.js.
   Map: Google Maps when a key is configured, otherwise OpenStreetMap via Leaflet. Both cluster markers. */

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

/* ---------- Helpers ---------- */
const DAYN = ["Vasárnap", "Hétfő", "Kedd", "Szerda", "Csütörtök", "Péntek", "Szombat"];
const MON = ["jan.", "febr.", "márc.", "ápr.", "máj.", "jún.", "júl.", "aug.", "szept.", "okt.", "nov.", "dec."];
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mins = t => { if (!t) return 0; const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const ymd = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const fold = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const km = (a, b) => { const R = 6371, r = x => x * Math.PI / 180, dLa = r(b[0] - a[0]), dLo = r(b[1] - a[1]); const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const massWord = c => c.rite === "gk" ? "Szent Liturgia" : "Szentmise";
const riteName = c => c.rite === "gk" ? "görögkatolikus" : "római katolikus";
const range = (a, b) => b ? a + "–" + b : a;

/* ---------- Data ---------- */
let CHURCHES = [];
// Internal shape: {id,name,city,addr,rite,lat,lon,web,phone,onlyServices,hours:[{days,o,c}],mass:[{d,t,n}],conf:[{d,f,u,n}],ador:[...],ev:[{date,t,title,n}],key}
function fromSample(c) {
  return { id: c.id, name: c.name, city: c.city, addr: c.addr, rite: c.rite, lat: c.lat, lon: c.lon,
    onlyServices: !c.hours, hours: c.hours || [], mass: c.mass, conf: c.conf, ador: c.ador || [], ev: c.ev };
}
function fromDb(c) {
  const sv = c.services || [], pick = k => sv.filter(s => s.kind === k);
  return { id: c.id, name: c.name, city: c.city || "", addr: c.address || "", rite: c.rite, lat: c.lat, lon: c.lon,
    web: c.website, phone: c.phone, onlyServices: c.open_only_services,
    hours: (c.hours || []).map(h => ({ days: h.days, o: h.opens, c: h.closes })),
    mass: pick("mass").map(s => ({ d: s.days, t: s.start, n: s.note })),
    conf: pick("confession").map(s => ({ d: s.days, f: s.start, u: s.end, n: s.note })),
    ador: pick("adoration").map(s => ({ d: s.days, f: s.start, u: s.end, n: s.note })),
    ev: (c.events || []).map(e => ({ date: e.date, t: e.start || "", title: e.title, n: e.note })) };
}
async function loadData() {
  if (!LIVE) { CHURCHES = SAMPLE_CHURCHES.map(fromSample); return; }
  const res = await fetch(`${SB_URL}/rest/v1/rpc/public_data`, { method: "POST", headers: { ...SB_HEADERS, "Content-Type": "application/json" }, body: "{}" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  CHURCHES = (await res.json()).map(fromDb);
}
const hasSchedule = c => c.mass.length + c.conf.length + c.ador.length > 0;

function dayItems(c, date) {
  const dow = date.getDay(), key = ymd(date), out = [];
  c.mass.filter(m => m.d.includes(dow)).forEach(m => out.push({ k: "mass", t: m.t, end: null, what: massWord(c), n: m.n }));
  c.conf.filter(m => m.d.includes(dow)).forEach(m => out.push({ k: "conf", t: m.f, end: m.u || null, what: "Gyóntatás", n: m.n }));
  c.ador.filter(m => m.d.includes(dow)).forEach(m => out.push({ k: "ador", t: m.f, end: m.u || null, what: "Szentségimádás", n: m.n }));
  c.ev.filter(e => e.date === key).forEach(e => out.push({ k: "ev", t: e.t, end: null, what: e.title, n: e.n }));
  return out.sort((a, b) => mins(a.t) - mins(b.t));
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
const S = { q: "", dayOffset: 0, origin: "Budapest", f: { open: false, mass: false, conf: false, ev: false }, sel: null, loading: true, error: "" };
try { const saved = JSON.parse(localStorage.getItem("harangszo") || "{}"); if (saved.origin && ORIGINS[saved.origin]) S.origin = saved.origin; } catch (e) { }
const now = () => new Date();
const selDate = () => { const d = now(); d.setDate(d.getDate() + S.dayOffset); return d; };
const isToday = () => S.dayOffset === 0;

function filtered() {
  const d = selDate(), q = fold(S.q.trim()), o = ORIGINS[S.origin], n = now();
  const today = ymd(d), wk = new Date(d); wk.setDate(wk.getDate() + 7); const wkEnd = ymd(wk);
  const out = [];
  for (const c of CHURCHES) {
    if (q && !c.key.includes(q)) continue;
    const items = dayItems(c, d);
    const r = { c, items, dist: km(o, [c.lat, c.lon]), os: openState(c, n),
      hasMass: items.some(i => i.k === "mass"), hasConf: items.some(i => i.k === "conf"),
      weekEv: c.ev.some(e => e.date >= today && e.date < wkEnd) };
    if (S.f.open && !(r.os.known && r.os.open)) continue;
    if (S.f.mass && !r.hasMass) continue;
    if (S.f.conf && !r.hasConf) continue;
    if (S.f.ev && !r.weekEv) continue;
    out.push(r);
  }
  return out.sort((a, b) => a.dist - b.dist);
}
function upcoming(items) {
  if (!isToday()) return items;
  const m = now().getHours() * 60 + now().getMinutes();
  return items.filter(i => !i.t || mins(i.end || i.t) >= m);
}

/* ---------- Rendering: list ---------- */
const panel = $("#panel");
function dayLabel(off) { const d = new Date(); d.setDate(d.getDate() + off); return off === 0 ? "Ma" : off === 1 ? "Holnap" : DAYN[d.getDay()] + ", " + MON[d.getMonth()] + " " + d.getDate() + "."; }
function controlsHTML() {
  const opts = [...Array(8).keys()].map(i => `<option value="${i}" ${i === S.dayOffset ? "selected" : ""}>${dayLabel(i)}</option>`).join("");
  const ors = Object.keys(ORIGINS).map(k => `<option ${k === S.origin ? "selected" : ""}>${esc(k)}</option>`).join("")
    + (navigator.geolocation && !ORIGINS["Saját helyzetem"] ? `<option value="__me">Saját helyzetem…</option>` : "");
  const chip = (k, cls, label, dot) => `<button class="chip ${cls}" data-f="${k}" aria-pressed="${S.f[k]}"><span class="dot" style="background:${dot}"></span>${label}</button>`;
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
      ${chip("conf", "conf", "Gyóntatás", "var(--penance)")}${chip("mass", "mass", "Mise", "var(--accent)")}${isToday() ? chip("open", "open", "Most nyitva", "var(--open)") : ""}${chip("ev", "ev", "Esemény a héten", "var(--gold)")}
    </div>
    <div class="summary" id="summary"></div>
  </div>`;
}
function cardHTML(r) {
  const up = upcoming(r.items).filter(i => i.k !== "ador").slice(0, 3);
  let pills = up.map(i => `<span class="pill p-${i.k}">${i.t ? `<span class="t">${i.t}</span>` : ""}${i.k === "mass" ? "mise" : i.k === "conf" ? "gyónás" : esc(i.what.length > 24 ? i.what.slice(0, 22) + "…" : i.what)}</span>`).join("");
  if (!pills) pills = !hasSchedule(r.c) ? `<span class="pill p-closed">Még nincs feltöltött időpont</span>`
    : `<span class="pill p-closed">${isToday() ? "Ma már nincs több alkalom" : "Nincs alkalom ezen a napon"}</span>`;
  const os = isToday() && r.os.label ? `<span class="pill ${r.os.known && r.os.open ? "p-open" : "p-closed"}">${r.os.label}</span>` : "";
  const rite = r.c.rite === "gk" ? `<span class="pill p-rite">görögkatolikus</span>` : "";
  const where = [r.c.city, r.c.addr].filter(Boolean).join(", ");
  return `<li><button class="card" data-id="${r.c.id}" aria-current="${S.sel === r.c.id}">
    <div class="card-top"><div><h3>${esc(r.c.name)}</h3><div class="where">${esc(where)}</div></div><span class="dist">${r.dist < 1 ? "<1" : Math.round(r.dist)} km</span></div>
    <div class="next">${os}${rite}${pills}</div></button></li>`;
}
function renderList() {
  if (S.loading || S.error) {
    panel.innerHTML = `<div class="empty pad">${S.error ? esc(S.error) : "Templomok betöltése…"}</div>`;
    return;
  }
  const rows = filtered(), shown = rows.slice(0, LIST_LIMIT);
  const more = rows.length - shown.length;
  panel.innerHTML = controlsHTML() + `<ul class="list pad">${shown.map(cardHTML).join("") || `<li class="empty">Nincs a szűrőknek megfelelő templom. Próbálj másik napot vagy kapcsolj ki egy szűrőt.</li>`}
    ${more > 0 ? `<li class="empty">További ${more.toLocaleString("hu-HU")} templom. Írj be egy települést, vagy válassz másik kiindulópontot.</li>` : ""}</ul>`;
  const nConf = rows.filter(r => r.hasConf).length;
  $("#summary").textContent = `${rows.length.toLocaleString("hu-HU")} templom · ${nConf} helyen gyóntatnak ${isToday() ? "ma" : "aznap"} · távolság: ${S.origin}`;
  bindControls(); drawMarkers(rows);
}
let searchTimer;
function bindControls() {
  $("#q").addEventListener("input", e => {
    S.q = e.target.value; clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { const pos = $("#q").selectionStart; renderList(); const n = $("#q"); n.focus(); try { n.setSelectionRange(pos, pos); } catch (_) { } }, 180);
  });
  $("#day").addEventListener("change", e => { S.dayOffset = +e.target.value; if (!isToday()) S.f.open = false; render(); });
  $("#origin").addEventListener("change", e => {
    if (e.target.value === "__me") return locateMe();
    S.origin = e.target.value; try { localStorage.setItem("harangszo", JSON.stringify({ origin: S.origin })); } catch (_) { } render();
  });
  panel.querySelectorAll(".chip").forEach(b => b.addEventListener("click", () => { S.f[b.dataset.f] = !S.f[b.dataset.f]; renderList(); }));
  panel.querySelectorAll(".card").forEach(b => b.addEventListener("click", () => select(+b.dataset.id)));
}
function locateMe() {
  $("#summary").textContent = "Helymeghatározás…";
  navigator.geolocation.getCurrentPosition(p => {
    ORIGINS["Saját helyzetem"] = [p.coords.latitude, p.coords.longitude]; S.origin = "Saját helyzetem";
    MapView.focus(p.coords.latitude, p.coords.longitude, 12); render();
  }, () => { render(); $("#summary").textContent = "A helyzeted nem érhető el. Engedélyezd a böngészőben, vagy válassz várost."; }, { timeout: 10000, maximumAge: 300000 });
}

/* ---------- Rendering: detail ---------- */
function weekTable(c) {
  const today = now().getDay();
  return [1, 2, 3, 4, 5, 6, 0].map(dow => {
    const ms = c.mass.filter(m => m.d.includes(dow)).map(m => m.t).sort((a, b) => mins(a) - mins(b)).join(", ") || "–";
    const cs = c.conf.filter(m => m.d.includes(dow)).map(m => range(m.f, m.u)).join(", ");
    return `<tr class="${dow === today ? "today" : ""}"><th scope="row">${DAYN[dow].slice(0, 3)}.</th><td>${ms}${cs ? `<br><span class="c">gyón. ${cs}</span>` : ""}</td><td>${hoursText(c, dow)}</td></tr>`;
  }).join("");
}
function renderDetail() {
  const c = CHURCHES.find(x => x.id === S.sel); if (!c) { S.sel = null; return renderList(); }
  const d = selDate(), items = dayItems(c, d), m = now().getHours() * 60 + now().getMinutes();
  const os = openState(c, now());
  const label = k => k === "mass" ? massWord(c) : k === "conf" ? "Gyóntatás" : k === "ador" ? "Szentségimádás" : "Esemény";
  const slots = items.map(i => {
    const past = isToday() && i.t && mins(i.end || i.t) < m;
    return `<div class="slot ${past ? "past" : ""}"><span class="t">${i.t || "–"}${i.end ? "–<br>" + i.end : ""}</span><div><div class="k k-${i.k}">${label(i.k)}</div><div class="what">${i.k === "ev" ? esc(i.what) : esc(i.n)}</div>${i.k === "ev" && i.n ? `<div class="note">${esc(i.n)}</div>` : ""}</div></div>`;
  }).join("") || `<div class="slot"><span class="t">–</span><div class="what muted">${hasSchedule(c) ? "Nincs meghirdetett alkalom ezen a napon." : "Ehhez a templomhoz még nincs feltöltött időpont. Ha tudod a miserendet, küldd be lent."}</div></div>`;
  const evs = c.ev.filter(e => e.date >= ymd(now())).sort((a, b) => a.date.localeCompare(b.date)).map(e => {
    const dt = new Date(e.date + "T12:00");
    return `<div class="ev"><div class="date"><b>${dt.getDate()}</b><small>${MON[dt.getMonth()]}</small></div><div><h5>${esc(e.title)}</h5><div class="muted">${DAYN[dt.getDay()]}${e.t ? ", " + e.t : ""}${e.n ? " · " + esc(e.n) : ""}</div></div></div>`;
  }).join("") || `<p class="muted">Nincs meghirdetett esemény. Ha tudsz egyről, küldd be lent.</p>`;
  const dir = `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lon}`;
  const where = [c.city, c.addr].filter(Boolean).join(", ");
  const contact = [c.web ? `<a href="${esc(/^https?:/i.test(c.web) ? c.web : "https://" + c.web)}" target="_blank" rel="noopener noreferrer">Weboldal</a>` : "", c.phone ? `<span>${esc(c.phone)}</span>` : ""].filter(Boolean).join(" · ");
  panel.innerHTML = `<div class="detail pad">
    <button class="back" id="back">← Vissza a listához</button>
    <div class="d-head">
      <div class="next">${os.label ? `<span class="pill ${os.known && os.open ? "p-open" : "p-closed"}">${os.label}</span>` : ""}<span class="pill p-rite">${riteName(c)}</span></div>
      <h2>${esc(c.name)}</h2>
      <div class="where">${esc(where)} · ${Math.round(km(ORIGINS[S.origin], [c.lat, c.lon]))} km (${esc(S.origin)})</div>
      ${contact ? `<div class="where">${contact}</div>` : ""}
    </div>
    <div class="actions"><a class="btn primary" href="${dir}" target="_blank" rel="noopener noreferrer">Útvonal a Google Térképen</a><button class="btn" id="go-suggest">Javítás beküldése</button></div>
    <div class="sec"><h4>${dayLabel(S.dayOffset)}</h4><div class="dayline">${slots}</div></div>
    ${hasSchedule(c) || c.hours.length ? `<div class="sec"><h4>Heti rend</h4><div class="week"><table><tbody>${weekTable(c)}</tbody></table></div></div>` : ""}
    <div class="sec"><h4>Közelgő események</h4><div class="ev-list">${evs}</div></div>
    <div class="sec" id="suggest-sec"><h4>Pontosítás vagy új időpont</h4>${suggestForm()}</div>
  </div>`;
  $("#back").addEventListener("click", () => { S.sel = null; render(); });
  $("#go-suggest").addEventListener("click", () => { $("#suggest-sec").scrollIntoView({ behavior: "smooth", block: "start" }); setTimeout(() => $("#s-text")?.focus(), 300); });
  bindSuggest(c);
  drawMarkers(filtered());
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

function leafletView() {
  const map = L.map("map", { minZoom: 6, maxZoom: 18, zoomSnap: .25, maxBounds: [[44.9, 15.3], [49.4, 23.8]] });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-közreműködők' }).addTo(map);
  map.fitBounds([[HU_BOUNDS.s, HU_BOUNDS.w], [HU_BOUNDS.n, HU_BOUNDS.e]]);
  const group = L.markerClusterGroup ? L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 50, chunkedLoading: true,
    iconCreateFunction: cl => L.divIcon({ className: "", html: `<div class="cluster">${cl.getChildCount()}</div>`, iconSize: [36, 36] }) }) : L.layerGroup();
  map.addLayer(group);
  const cache = new Map();
  window.addEventListener("resize", () => map.invalidateSize());
  return {
    draw(list) {
      const arr = [];
      for (const p of list) {
        let e = cache.get(p.c.id);
        if (!e) { const mk = L.marker([p.c.lat, p.c.lon], { title: p.c.name, riseOnHover: true }); mk.on("click", () => select(p.c.id)); e = { mk, sig: "" }; cache.set(p.c.id, e); }
        const sig = p.cls + (p.sel ? "*" : "");
        if (e.sig !== sig) { e.mk.setIcon(L.divIcon({ className: "", html: `<div class="pin ${p.cls} ${p.sel ? "sel" : ""}"><i></i></div>`, iconSize: [26, 26], iconAnchor: [13, 26] })); e.mk.setZIndexOffset(p.sel ? 1000 : 0); e.sig = sig; }
        arr.push(e.mk);
      }
      group.clearLayers(); group.addLayers ? group.addLayers(arr) : arr.forEach(m => group.addLayer(m));
    },
    focus(lat, lon, z) { map.flyTo([lat, lon], Math.max(map.getZoom(), z), { duration: .5 }); }
  };
}
function googleView() {
  let gmap = null, clusterer = null, pending = null, pendingFocus = null;
  const cache = new Map();
  window.__initGoogle = () => {
    gmap = new google.maps.Map(document.getElementById("map"), { center: { lat: 47.16, lng: 19.5 }, zoom: 7,
      restriction: { latLngBounds: { north: 49.4, south: 44.9, west: 15.3, east: 23.8 } }, mapTypeControl: false, streetViewControl: false, fullscreenControl: false, clickableIcons: false });
    gmap.fitBounds({ north: HU_BOUNDS.n, south: HU_BOUNDS.s, west: HU_BOUNDS.w, east: HU_BOUNDS.e });
    const MC = window.markerClusterer?.MarkerClusterer;
    if (MC) clusterer = new MC({ map: gmap, markers: [], renderer: { render: ({ count, position }) => new google.maps.Marker({ position, zIndex: 900 + count,
      label: { text: String(count), color: "#fff", fontSize: "12px", fontWeight: "600" },
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 17, fillColor: css("--accent") || "#23408e", fillOpacity: .9, strokeColor: "#fff", strokeWeight: 2 } }) } });
    if (pending) api.draw(pending); if (pendingFocus) api.focus(...pendingFocus);
  };
  window.gm_authFailure = () => { $(".notice").innerHTML = "<b>Térképhiba.</b> A Google Maps kulcs nem érvényes ehhez a címhez. Ellenőrizd a kulcs webhely-korlátozását."; };
  const s = document.createElement("script");
  s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(MAPS_KEY)}&callback=__initGoogle&language=hu&region=HU&loading=async`;
  s.async = true; document.head.appendChild(s);
  const color = cls => cls === "conf" ? (css("--penance") || "#6a2e8c") : cls === "mass" ? (css("--accent") || "#23408e") : (css("--ink-3") || "#7b8496");
  const api = {
    draw(list) {
      if (!gmap) { pending = list; return; }
      const arr = [];
      for (const p of list) {
        let e = cache.get(p.c.id);
        if (!e) { const mk = new google.maps.Marker({ position: { lat: p.c.lat, lng: p.c.lon }, title: p.c.name }); mk.addListener("click", () => select(p.c.id)); e = { mk, sig: "" }; cache.set(p.c.id, e); }
        const sig = p.cls + (p.sel ? "*" : "");
        if (e.sig !== sig) { e.mk.setIcon({ url: pinSVG(color(p.cls), p.sel), scaledSize: new google.maps.Size(30, 38), anchor: new google.maps.Point(15, 37) }); e.mk.setZIndex(p.sel ? 1000 : 1); e.sig = sig; }
        arr.push(e.mk);
      }
      if (clusterer) { clusterer.clearMarkers(true); clusterer.addMarkers(arr); }
      else { cache.forEach(e => e.mk.setMap(null)); arr.forEach(m => m.setMap(gmap)); }
    },
    focus(lat, lon, z) { if (!gmap) { pendingFocus = [lat, lon, z]; return; } gmap.panTo({ lat, lng: lon }); if (gmap.getZoom() < z) gmap.setZoom(z); }
  };
  return api;
}
const MapView = MAPS_KEY ? googleView() : (typeof L !== "undefined" ? leafletView() : { draw() { }, focus() { } });
if (!MAPS_KEY && typeof L === "undefined") $("#map").innerHTML = '<p style="padding:16px;color:var(--ink-3)">A térkép nem töltődött be. A lista ettől még használható.</p>';

function drawMarkers(rows) {
  const list = rows.map(r => ({ c: r.c, cls: r.hasConf ? "conf" : r.hasMass ? "mass" : "dim", sel: S.sel === r.c.id }));
  if (S.sel && !list.some(p => p.sel)) { const c = CHURCHES.find(x => x.id === S.sel); if (c) list.push({ c, cls: "mass", sel: true }); }
  MapView.draw(list);
}
function select(id) {
  S.sel = id;
  const c = CHURCHES.find(x => x.id === id);
  if (c) MapView.focus(c.lat, c.lon, 15);
  render();
}

/* ---------- Boot ---------- */
function render() { S.sel ? renderDetail() : renderList(); }
$("#notice").innerHTML = LIVE
  ? `<b>Fejlesztés alatt.</b> Az időpontokat a plébániák és a hívek töltik fel, így sok templomnál még hiányoznak. Indulás előtt ellenőrizd a plébánián. ${OSM_DATA_CREDIT}.`
  : `<b>Bemutató.</b> A templomok valósak, de a mise-, gyóntatási és nyitvatartási időpontok kitalált mintaadatok. Indulás előtt mindig ellenőrizd a plébánián.`;
render();
loadData().then(() => {
  CHURCHES.forEach(c => c.key = fold(c.name + " " + c.city + " " + c.addr));
  S.loading = false; render();
}).catch(() => { S.loading = false; S.error = "Nem sikerült betölteni a templomokat. Frissítsd az oldalt egy kicsit később."; render(); });
setInterval(() => { if (!S.loading && isToday() && !document.activeElement?.matches("input,textarea,select")) render(); }, 60000);
