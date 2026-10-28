"use strict";
/* Harangszó admin panel. All permissions are enforced by the database (row level security);
   this page only hides what the signed-in person cannot change anyway. */

const CFG = window.HARANGSZO_CONFIG || {};
const real = v => typeof v === "string" && v && !v.startsWith("__");
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const main = $("#main");
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_SHORT = { 0: "V", 1: "H", 2: "K", 3: "Sze", 4: "Cs", 5: "P", 6: "Szo" };
const KINDS = { mass: "Mise", confession: "Gyóntatás", adoration: "Szentségimádás", rorate: "Rorate (advent)", prayer: "Imaóra, ájtatosság" };
const SOURCE_NAMES = { szfvar: "Székesfehérvári Egyházmegye miserendje", miserend: "miserend.hu" };
const TYPES = { conf: "Gyóntatási időpont", mass: "Mise időpont", hours: "Nyitvatartás", event: "Esemény", place: "Hely vagy egyéb" };
const hm = t => t ? String(t).slice(0, 5) : "";

if (!real(CFG.supabaseUrl) || !real(CFG.supabaseAnonKey) || !window.supabase) {
  main.innerHTML = `<div class="card-box login"><h2>Még nincs beállítva</h2><p>Az adatbázis (Supabase) adatai hiányoznak a <code>config.js</code> fájlból. Add meg a <code>SUPABASE_URL</code> és <code>SUPABASE_PUBLISHABLE_KEY</code> titkokat a GitHub-tárolóban, majd futtasd újra a közzétételt. Lépések: README.</p></div>`;
  throw new Error("not configured");
}
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
const A = { user: null, staff: null, myChurches: null, tab: "churches", q: "", f: null, filtersOpen: false, list: [], total: 0, sel: null, draft: null, suggStatus: "pending" };

/* ---------- Auth ---------- */
function renderLogin(msg = "") {
  $("#tabs").hidden = true; $("#who").innerHTML = "";
  main.innerHTML = `<form class="card-box login" id="login">
    <h2>Belépés</h2>
    <label class="field" for="em">E-mail<input id="em" type="email" autocomplete="username" required></label>
    <label class="field" for="pw">Jelszó<input id="pw" type="password" autocomplete="current-password" required></label>
    <button class="btn primary" type="submit">Belépés</button>
    <p class="msg err" id="lmsg" role="alert">${esc(msg)}</p>
    <p class="muted" style="margin:0">Szerkesztői fiókot az adminisztrátor hoz létre.</p>
  </form>`;
  $("#login").addEventListener("submit", async e => {
    e.preventDefault(); $("#lmsg").textContent = "Belépés…"; $("#lmsg").className = "msg";
    const { error } = await sb.auth.signInWithPassword({ email: $("#em").value.trim(), password: $("#pw").value });
    if (error) { $("#lmsg").textContent = error.message === "Invalid login credentials" ? "Hibás e-mail-cím vagy jelszó." : "Nem sikerült belépni: " + error.message; $("#lmsg").className = "msg err"; }
  });
}
async function afterLogin(user) {
  A.user = user;
  const { data: staff } = await sb.from("staff").select("role,display_name").eq("user_id", user.id).maybeSingle();
  A.staff = staff;
  $("#who").innerHTML = `<span>${esc(staff?.display_name || user.email)}${staff ? " · " + (staff.role === "admin" ? "adminisztrátor" : "plébániai szerkesztő") : ""}</span><button class="btn" id="logout">Kilépés</button>`;
  $("#logout").addEventListener("click", () => sb.auth.signOut());
  if (!staff) {
    $("#tabs").hidden = true;
    main.innerHTML = `<div class="card-box login" style="max-width:640px"><h2>Nincs szerkesztői jogod</h2>
      <p>Be vagy jelentkezve, de a fiókod még nincs felvéve szerkesztőnek. Kérd meg az adminisztrátort, hogy vegyen fel.</p>
      <p class="muted">Ha te vagy az első adminisztrátor, futtasd ezt a Supabase SQL Editorban:</p>
      <code class="snip">insert into public.staff (user_id, role, display_name)\nvalues ('${esc(user.id)}', 'admin', '${esc(user.email)}');</code>
      <p class="muted">Utána frissítsd ezt az oldalt.</p></div>`;
    return;
  }
  if (staff.role === "parish") {
    const { data } = await sb.from("staff_churches").select("church_id").eq("user_id", user.id);
    A.myChurches = (data || []).map(r => r.church_id);
  }
  $("#tabs").hidden = false;
  refreshSuggCount();
  renderTab();
}
sb.auth.onAuthStateChange((_ev, session) => { session?.user ? (A.user?.id !== session.user.id && afterLogin(session.user)) : (A.user = null, renderLogin()); });
sb.auth.getSession().then(({ data }) => { if (!data.session) renderLogin(); });

/* ---------- Tabs ---------- */
function setTab(t) { A.tab = t; $("#t-churches").setAttribute("aria-pressed", t === "churches"); $("#t-sugg").setAttribute("aria-pressed", t === "sugg"); renderTab(); }
$("#t-churches").addEventListener("click", () => setTab("churches"));
$("#t-sugg").addEventListener("click", () => setTab("sugg"));
function renderTab() { A.tab === "churches" ? renderChurches() : renderSuggestions(); }

/* ---------- Churches ---------- */
// Filters run in the database (view admin_church_list), so they cover every church, not just a loaded page.
const PAGE = 50;
const FILTERS = {
  rite: { label: "Rítus", opts: { "": "Mind", rk: "Római katolikus", gk: "Görögkatolikus" } },
  times: { label: "Miserend", opts: { "": "Mind", yes: "Van feltöltött időpont", no: "Nincs időpont" } },
  conf: { label: "Gyóntatás", opts: { "": "Mind", yes: "Van gyóntatás", no: "Nincs gyóntatás" } },
  extra: { label: "Egyéb", opts: { "": "Mind", pending: "Javaslat vár rá", rorate: "Van Rorate", feast: "Van ünnepi miserend", seasonal: "Van nyári/téli eltérés", events: "Van közelgő esemény", nohours: "Nincs nyitvatartás", nocity: "Nincs település megadva", approx: "Hely pontosítandó", dup: "Lehetséges duplikátum (130 m-en belül)", created: "Az import hozta létre", locked: "Kézzel ellenőrzött (zárolt)" } },
  vis: { label: "Láthatóság", opts: { "": "Mind", shown: "Látható", hidden: "Rejtett" } },
  imp: { label: "Kiemelés", opts: { "": "Mind", high: "Fontos (70 felett)", low: "Háttérben (20 alatt)", manual: "Kézzel beállított" } },
  src: { label: "Forrás", opts: { "": "Mind", osm: "OpenStreetMap-import", manual: "Kézzel felvett", szfvar: "Egyházmegyei miserend (Székesfehérvár)", miserend: "miserend.hu" } },
};
const SORTS = { name: "Név szerint", imp: "Fontosság szerint", updated: "Legutóbb módosított", pending: "Legtöbb javaslat" };
const fold = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const defaultFilters = () => ({ rite: "", times: "", conf: "", extra: "", vis: "", imp: "", src: "", sort: "name" });
try { const f = JSON.parse(localStorage.getItem("harangszo-admin-filters") || "null"); if (f) A.f = { ...defaultFilters(), ...f }; } catch (e) { }
A.f ||= defaultFilters();
const activeFilterCount = () => Object.keys(FILTERS).filter(k => A.f[k]).length;
const saveFilters = () => { try { localStorage.setItem("harangszo-admin-filters", JSON.stringify(A.f)); } catch (e) { } };

function buildQuery(from) {
  let q = sb.from("admin_church_list").select("id,name,city,published,n_services,has_confession,has_rorate,has_feast,n_pending,importance,importance_manual,from_osm,location_approx,schedule_source,schedule_locked,near_duplicate,created_by", { count: "exact" });
  const term = fold(A.q.trim()).replace(/[%,()*]/g, " ").trim();
  if (term) for (const w of term.split(/\s+/)) q = q.like("search", `%${w}%`);
  const f = A.f;
  if (f.rite) q = q.eq("rite", f.rite);
  if (f.times === "yes") q = q.gt("n_services", 0); else if (f.times === "no") q = q.eq("n_services", 0);
  if (f.conf) q = q.eq("has_confession", f.conf === "yes");
  ({ pending: () => q = q.gt("n_pending", 0), rorate: () => q = q.eq("has_rorate", true), feast: () => q = q.eq("has_feast", true),
     seasonal: () => q = q.eq("has_seasonal", true), events: () => q = q.gt("n_events", 0), nohours: () => q = q.eq("has_hours", false),
     nocity: () => q = q.eq("city", ""), approx: () => q = q.eq("location_approx", true), dup: () => q = q.eq("near_duplicate", true), created: () => q = q.not("created_by", "is", null), locked: () => q = q.eq("schedule_locked", true) })[f.extra]?.();
  if (f.vis) q = q.eq("published", f.vis === "shown");
  if (f.imp === "high") q = q.gte("importance", 70); else if (f.imp === "low") q = q.lte("importance", 20); else if (f.imp === "manual") q = q.not("importance_manual", "is", null);
  if (f.src === "szfvar" || f.src === "miserend") q = q.eq("schedule_source", f.src); else if (f.src) q = q.eq("from_osm", f.src === "osm");
  if (A.myChurches) q = q.in("id", A.myChurches.length ? A.myChurches : [-1]);
  const order = { name: ["name", true], imp: ["importance", false], updated: ["updated_at", false], pending: ["n_pending", false] }[f.sort] || ["name", true];
  q = q.order(order[0], { ascending: order[1] });
  if (order[0] !== "name") q = q.order("name", { ascending: true });
  return q.range(from, from + PAGE - 1);
}
function itemHTML(c) {
  const tags = [
    c.n_services ? `<span>${c.n_services} időpont</span>` : `<span class="warn">nincs időpont</span>`,
    c.has_confession ? `<span class="tag conf">gyóntatás</span>` : "",
    c.has_rorate ? `<span class="tag gold">rorate</span>` : "",
    c.has_feast ? `<span class="tag gold">ünnepi rend</span>` : "",
    c.n_pending ? `<span class="tag conf">${c.n_pending} javaslat</span>` : "",
    c.location_approx ? `<span class="warn">hely pontosítandó</span>` : "",
    c.near_duplicate ? `<span class="warn" title="130 m-en belül van egy másik templom is">duplikátum?</span>` : "",
    c.schedule_source ? `<span title="Az időpontok importból származnak">${c.schedule_locked ? "import, zárolt" : "import"}</span>` : "",
    c.published ? "" : `<span>rejtett</span>`,
    A.f.sort === "imp" || A.f.imp ? `<span title="Fontosság">★ ${c.importance}${c.importance_manual != null ? " (kézi)" : ""}</span>` : "",
  ].join("");
  return `<li><button data-id="${c.id}" aria-current="${A.sel === c.id}"><span class="nm">${esc(c.name)}</span>
    <span class="sub"><span>${esc(c.city || "– település nincs megadva –")}</span>${tags}</span></button></li>`;
}
let listToken = 0;
async function loadList(append = false) {
  const token = ++listToken, from = append ? A.list.length : 0;
  if (!append) { $("#clist").setAttribute("aria-busy", "true"); }
  const { data, error, count } = await buildQuery(from);
  if (token !== listToken) return;                 // a newer search has started; drop this answer
  $("#clist").removeAttribute("aria-busy");
  if (error) {
    const missing = /admin_church_list/.test(error.message || "") || error.code === "42P01" || error.code === "PGRST205";
    $("#clist").innerHTML = `<li class="msg err" style="padding:8px">${missing ? "A szűréshez futtasd a <code>supabase/migrations/004_admin_list.sql</code> fájlt a Supabase SQL Editorban." : "Nem sikerült betölteni: " + esc(error.message)}</li>`;
    $("#ccount").textContent = ""; $("#more").hidden = true; return;
  }
  A.list = append ? A.list.concat(data) : (data || []);
  A.total = count ?? A.list.length;
  $("#clist").innerHTML = A.list.map(itemHTML).join("") || `<li class="muted" style="padding:8px">Nincs a szűrőknek megfelelő templom.</li>`;
  $("#ccount").textContent = `${A.total.toLocaleString("hu-HU")} templom`;
  const left = A.total - A.list.length;
  $("#more").hidden = left <= 0; $("#more").textContent = `Továbbiak betöltése (még ${left.toLocaleString("hu-HU")})`;
}
function filtersHTML() {
  const n = activeFilterCount();
  return `<details class="filters" ${A.filtersOpen ? "open" : ""} id="filters">
      <summary>Szűrők${n ? ` <span class="badge">${n}</span>` : ""}</summary>
      <div class="fgrid">
        ${Object.entries(FILTERS).map(([k, f]) => `<label class="field" for="f-${k}">${f.label}<select id="f-${k}" data-filter="${k}">${Object.entries(f.opts).map(([v, t]) => `<option value="${v}" ${A.f[k] === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>`).join("")}
        <label class="field" for="f-sort">Rendezés<select id="f-sort" data-filter="sort">${Object.entries(SORTS).map(([v, t]) => `<option value="${v}" ${A.f.sort === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      </div>
      <div class="row"><button type="button" class="btn" id="clear-filters" ${n || A.q ? "" : "disabled"}>Szűrők törlése</button></div>
    </details>`;
}
function renderChurches() {
  const isAdmin = A.staff.role === "admin";
  main.innerHTML = `<div class="split">
    <aside class="side">
      <label class="search" for="cq"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="cq" type="search" placeholder="Név, település vagy cím" value="${esc(A.q)}" autocomplete="off"></label>
      <div id="filters-wrap">${filtersHTML()}</div>
      <div class="row"><span class="muted" id="ccount" role="status"></span>${isAdmin ? `<button class="btn" id="new-church" style="margin-left:auto">Új templom</button>` : ""}</div>
      <ul class="clist" id="clist"><li class="muted" style="padding:8px">Betöltés…</li></ul>
      <button class="btn" id="more" hidden></button>
    </aside>
    <section id="editor"><div class="card-box"><p class="muted" style="margin:0">Válassz templomot a listából${isAdmin ? ", vagy vegyél fel újat" : ""}.</p></div></section>
  </div>`;
  let t; $("#cq").addEventListener("input", e => { A.q = e.target.value; clearTimeout(t); t = setTimeout(() => { loadList(); refreshFilterUI(); }, 250); });
  bindFilters();
  $("#more").addEventListener("click", () => loadList(true));
  $("#clist").addEventListener("click", e => { const b = e.target.closest("button[data-id]"); if (b) openChurch(+b.dataset.id); });
  $("#new-church")?.addEventListener("click", () => { A.sel = null; A.draft = blankChurch(); renderEditor(); });
  loadList();
  if (A.draft) renderEditor();
}
function refreshFilterUI() { $("#filters-wrap").innerHTML = filtersHTML(); bindFilters(); }
function bindFilters() {
  $("#filters").addEventListener("toggle", e => { A.filtersOpen = e.target.open; });
  $("#filters").addEventListener("change", e => {
    const k = e.target.dataset.filter; if (!k) return;
    A.f[k] = e.target.value; saveFilters(); loadList(); refreshFilterUI();
  });
  $("#clear-filters").addEventListener("click", () => { A.f = defaultFilters(); A.q = ""; $("#cq").value = ""; saveFilters(); loadList(); refreshFilterUI(); });
}
const blankChurch = () => ({ id: null, schedule_note: "", schedule_locked: false, location_approx: false, schedule_source: null, importance_manual: "", importance_auto: null, name: "", city: "", address: "", rite: "rk", lat: "", lon: "", website: "", phone: "", notes: "", open_only_services: false, published: true, hours: [], services: [], feasts: {}, events: [] });
async function openChurch(id) {
  if (A.dirty && !confirmDiscard()) return;
  A.sel = id;
  $("#clist")?.querySelectorAll("button").forEach(b => b.setAttribute("aria-current", +b.dataset.id === id));
  $("#editor").innerHTML = `<div class="card-box"><p class="muted" style="margin:0">Betöltés…</p></div>`;
  const { data, error } = await sb.from("churches").select("*, opening_hours(*), services(*), events(*)").eq("id", id).single();
  if (error) { $("#editor").innerHTML = `<div class="card-box msg err">Nem sikerült megnyitni: ${esc(error.message)}</div>`; return; }
  const byTime = (a, b) => String(a.start_time).localeCompare(String(b.start_time));
  const KORDER = { mass: 0, rorate: 1, confession: 2, adoration: 3 };
  // Feast schedules: Sunday-rule feasts from churches.feast_sunday, custom ones from services rows with a feast key.
  const feasts = {};
  data.opening_hours ||= []; data.services ||= []; data.events ||= [];
  for (const k of data.feast_sunday || []) feasts[k] = { mode: "sunday", rows: [] };
  for (const s of data.services.filter(s => s.feast).sort(byTime)) {
    (feasts[s.feast] ||= { mode: "custom", rows: [] }).mode = "custom";
    feasts[s.feast].rows.push({ kind: s.kind, start: hm(s.start_time), end: hm(s.end_time), note: s.note || "" });
  }
  A.draft = { ...data,
    hours: data.opening_hours.map(h => ({ days: h.days, opens: hm(h.opens), closes: hm(h.closes) })),
    services: data.services.filter(s => !s.feast).sort((a, b) => KORDER[a.kind] - KORDER[b.kind] || (a.period || "").localeCompare(b.period || "") || byTime(a, b))
      .map(s => ({ kind: s.kind, days: s.days, start: hm(s.start_time), end: hm(s.end_time), note: s.note || "", period: s.period || "all", valid: s.valid || "", weeks: s.weeks || [],
        every: s.every || 1, anchor: s.anchor || "", tags: s.tags || [] })),
    feasts,
    events: data.events.sort((a, b) => String(a.date).localeCompare(String(b.date))).map(e => ({ date: e.date, start: hm(e.start_time), title: e.title, note: e.note || "" })) };
  A.dirty = false; A.svcSnapshot = JSON.stringify([A.draft.services, A.draft.feasts]); A.lockTouched = false;
  renderEditor();
}
// The viewer's confirm() works on this normal web page (it is not inside a Claude artifact).
function confirmDiscard() { return window.confirm("Van mentetlen módosításod ennél a templomnál. Eldobod?"); }

/* 24-hour time fields: plain text so every browser shows 17:30 (never AM/PM). Accepts 1730, 17.30, 17,30, 9:5, 17. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function normTime(v) {
  v = String(v || "").trim().replace(/[.,h ]/g, ":");
  if (!v) return "";
  let m = v.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m && /^\d{3,4}$/.test(v)) m = [null, v.slice(0, v.length - 2), v.slice(-2)];
  if (!m && /^\d{1,2}$/.test(v)) m = [null, v, "0"];
  if (!m) return v;
  const h = +m[1], mi = +m[2];
  return h <= 23 && mi <= 59 ? String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0") : v;
}
const timeField = (id, label, attrs, value) =>
  `<label class="field tf" for="${id}">${label}<input type="text" class="hhmm" id="${id}" ${attrs} value="${esc(value)}" inputmode="numeric" maxlength="5" placeholder="ÓÓ:PP" autocomplete="off" spellcheck="false"></label>`;

function daysHTML(days, path) {
  return `<div class="days" role="group" aria-label="Napok">${DAY_ORDER.map(d => `<button type="button" data-days="${path}" data-d="${d}" aria-pressed="${days.includes(d)}">${DAY_SHORT[d]}</button>`).join("")}</div>`;
}
const PERIODS = { all: "Egész évben", summer: "Nyáron", winter: "Télen", advent: "Adventben", lent: "Nagyböjtben", eastertide: "Húsvéti időben",
  school: "Tanévben", holiday: "Nyári szünetben", autumn: "Ősszel", spring: "Tavasszal", custom: "Egyedi időszak" };
const MOVING = { summer: "óraátállítás", winter: "óraátállítás", advent: "egyházi év", lent: "egyházi év", eastertide: "egyházi év", school: "09.01–06.15", holiday: "06.16–08.31", autumn: "09.01–10.31", spring: "03.01–04.30" };
const EVERY_OPTS = { 1: "Minden héten", 2: "Kéthetente", 3: "Háromhetente", 4: "Négyhetente" };
// Tags editors can set (calendar.js TAGS); languages through the language list.
const TAG_BTNS = ["family", "student", "youth", "university", "guitar", "organ", "choir", "silent", "vigil", "traditional", "word", "confession", "irregular"];
const LANG_OPTS = Object.entries(LitCal.LANGS).filter(([k]) => k !== "hu");
const WEEK_BTNS = [[1, "1."], [2, "2."], [3, "3."], [4, "4."], [5, "5."], [-1, "Utolsó"]];
// "05-01/08-31,10-01/10-31" ↔ "05.01–08.31, 10.01–10.31"
const validToText = v => (v || "").split(",").filter(Boolean).map(r => r.split("/").map(x => x.replace("-", ".")).join("–")).join(", ");
function textToValid(t) {
  t = (t || "").trim(); if (!t) return "";
  const out = [];
  for (const part of t.split(/[,;]+/).map(x => x.trim()).filter(Boolean)) {
    const m = part.match(/^(\d{1,2})[.\-/](\d{1,2})\.?\s*[–—-]\s*(\d{1,2})[.\-/](\d{1,2})\.?$/);
    if (!m) return null;
    const [a, b, c2, d] = m.slice(1).map(Number);
    if (a < 1 || a > 12 || c2 < 1 || c2 > 12 || b < 1 || b > 31 || d < 1 || d > 31) return null;
    const f = (x, y) => String(x).padStart(2, "0") + "-" + String(y).padStart(2, "0");
    out.push(f(a, b) + "/" + f(c2, d));
  }
  return out.join(",");
}
function serviceRow(s, i) {
  const isRorate = s.kind === "rorate";
  const sel = s.period === "all" && (s.valid || s.customRange) ? "custom" : s.period;
  const showRange = !isRorate && (sel !== "all");
  const weeks = s.weeks || [], tags = s.tags || [], every = +s.every || 1;
  const lang = tags.find(t => t.startsWith("lang:"))?.slice(5) || "";
  return `<div class="srow ${sel !== "all" || weeks.length || every > 1 ? "seasonal" : ""}">
    <label class="field" for="s-k-${i}">Fajta<select id="s-k-${i}" data-l="services" data-i="${i}" data-f="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${s.kind === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    ${daysHTML(s.days, "services." + i)}
    ${timeField(`s-s-${i}`, "Kezdés", `data-l="services" data-i="${i}" data-f="start"`, s.start)}
    ${s.kind === "mass" || isRorate ? "" : timeField(`s-e-${i}`, "Vége", `data-l="services" data-i="${i}" data-f="end"`, s.end)}
    ${isRorate ? `<span class="hint">Csak adventben látszik</span>` : `<label class="field" for="s-p-${i}" title="Nyár/tél = az óraátállításhoz igazodik, hacsak meg nem adsz pontos időszakot">Időszak<select id="s-p-${i}" data-period="${i}">${Object.entries(PERIODS).map(([k, v]) => `<option value="${k}" ${sel === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>`}
    ${showRange ? `<label class="field range" for="s-v-${i}">Pontos időszak${MOVING[sel] ? ` (üresen: ${MOVING[sel]})` : ""}<input id="s-v-${i}" data-valid="${i}" value="${esc(validToText(s.valid))}" placeholder="pl. 05.01–08.31" autocomplete="off"></label>` : ""}
    <label class="field" for="s-x-${i}">Ismétlődés<select id="s-x-${i}" data-every="${i}">${Object.entries(EVERY_OPTS).map(([k, v]) => `<option value="${k}" ${every === +k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    ${every > 1 ? `<label class="field" for="s-a-${i}" title="Egy nap, amikor biztosan van – ettől számolva minden ${every}. héten">Egyik alkalom napja<input id="s-a-${i}" type="date" data-anchor="${i}" value="${esc(s.anchor || "")}"></label>` : ""}
    <div class="weeks"><span class="muted">A hónap hetei:</span><div class="days" role="group" aria-label="A hónap hetei">${WEEK_BTNS.map(([n, t]) => `<button type="button" data-weeks="${i}" data-n="${n}" aria-pressed="${weeks.includes(n)}">${t}</button>`).join("")}</div><span class="muted">${weeks.length ? "" : "minden héten"}</span></div>
    ${s.kind === "mass" || isRorate ? `<div class="weeks"><span class="muted">Jellege:</span><div class="days" role="group" aria-label="A mise jellege">${TAG_BTNS.map(t => `<button type="button" data-tag="${i}" data-t="${t}" aria-pressed="${tags.includes(t)}">${esc(LitCal.TAGS[t])}</button>`).join("")}</div>
      <label class="check" for="s-l-${i}">Nyelv <select id="s-l-${i}" data-lang="${i}"><option value="">magyar</option>${LANG_OPTS.map(([k, v]) => `<option value="${k}" ${lang === k ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label></div>` : ""}
    <label class="field note" for="s-n-${i}">${s.kind === "prayer" ? "Megnevezés" : "Megjegyzés"}<input id="s-n-${i}" data-l="services" data-i="${i}" data-f="note" value="${esc(s.note)}" placeholder="${isRorate ? "pl. gyertyafényes hajnali mise" : s.kind === "prayer" ? "pl. Vesperás, rózsafüzér, keresztút" : "pl. utána szentségimádás"}"></label>
    <button type="button" class="icon-btn" data-del="services" data-i="${i}" aria-label="Sor törlése">Törlés</button></div>`;
}
const FEAST_KINDS = { mass: "Mise", confession: "Gyóntatás", adoration: "Szentségimádás" };
function feastsHTML(c) {
  const keys = window.LitCal.FEASTS.map(f => f.key).filter(k => c.feasts[k]);
  const avail = window.LitCal.FEASTS.filter(f => !c.feasts[f.key]);
  const today = new Date();
  const cards = keys.map(k => {
    const f = c.feasts[k], fe = window.LitCal.FEAST_BY_KEY[k], next = window.LitCal.nextFeastDate(k, today);
    return `<div class="feastcard">
      <div class="row"><strong>${esc(fe.name)}</strong><span class="muted">${next.getFullYear()}. ${next.toLocaleDateString("hu-HU", { month: "long", day: "numeric", weekday: "long" })}</span>
        <button type="button" class="icon-btn" data-delfeast="${k}" style="margin-left:auto">Ünnep eltávolítása</button></div>
      <div class="row">
        <label class="check" for="fm-s-${k}"><input type="radio" name="fm-${k}" id="fm-s-${k}" data-feastmode="${k}" value="sunday" ${f.mode === "sunday" ? "checked" : ""}>Vasárnapi miserend szerint</label>
        <label class="check" for="fm-c-${k}"><input type="radio" name="fm-${k}" id="fm-c-${k}" data-feastmode="${k}" value="custom" ${f.mode === "custom" ? "checked" : ""}>Egyedi időpontok</label>
      </div>
      ${f.mode === "custom" ? `<div class="rows">${f.rows.map((r, i) => `<div class="srow">
          <label class="field" for="fk-${k}-${i}">Fajta<select id="fk-${k}-${i}" data-feast="${k}" data-i="${i}" data-f="kind">${Object.entries(FEAST_KINDS).map(([kk, v]) => `<option value="${kk}" ${r.kind === kk ? "selected" : ""}>${v}</option>`).join("")}</select></label>
          ${timeField(`fs-${k}-${i}`, "Kezdés", `data-feast="${k}" data-i="${i}" data-f="start"`, r.start)}
          ${r.kind === "mass" ? "" : timeField(`fe-${k}-${i}`, "Vége", `data-feast="${k}" data-i="${i}" data-f="end"`, r.end)}
          <label class="field note" for="fn-${k}-${i}">Megjegyzés<input id="fn-${k}-${i}" data-feast="${k}" data-i="${i}" data-f="note" value="${esc(r.note)}" placeholder="pl. ünnepi nagymise"></label>
          <button type="button" class="icon-btn" data-delfeastrow="${k}" data-i="${i}" aria-label="Sor törlése">Törlés</button></div>`).join("")}</div>
        <div class="row"><button type="button" class="btn" data-addfeastrow="${k}">+ Időpont</button>${k === "dec24" ? `<span class="hint">Az éjféli misét 00:00-ként add meg; a térképen 24:00-ként, a nap végén látszik.</span>` : ""}</div>` : `<p class="muted" style="margin:0">Ezen a napon a vasárnapi rendszeres alkalmak érvényesek.</p>`}
    </div>`;
  }).join("");
  return `<div class="block"><h3>Ünnepi miserend</h3>
    <p class="muted" style="margin:0">Ünnepnapon az itt megadott rend lép a hétköznapi helyére. Ha egy ünnep nincs felvéve, aznap a szokásos miserend látszik.</p>
    ${cards}
    <div class="row"><label class="field" for="add-feast" style="flex:1 1 240px">Ünnep hozzáadása<select id="add-feast">${avail.map(f => `<option value="${f.key}">${esc(f.name)}</option>`).join("")}</select></label>
      <button type="button" class="btn" id="add-feast-btn" ${avail.length ? "" : "disabled"}>Hozzáadás</button></div>
  </div>`;
}
function renderEditor() {
  const c = A.draft, isAdmin = A.staff.role === "admin";
  const osm = c.lat && c.lon ? `https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lon}#map=18/${c.lat}/${c.lon}` : "";
  const scroll = document.scrollingElement.scrollTop;
  $("#editor").innerHTML = `<form class="card-box editor" id="ed" novalidate>
    <div><h2>${c.id ? esc(c.name) : "Új templom"}</h2>${c.id ? `<span class="muted" style="font-size:.8rem">Azonosító: ${c.id}</span>` : ""}</div>
    <div class="block"><h3>Alapadatok</h3>
      <div class="grid2">
        <label class="field" for="f-name">Név<input id="f-name" data-k="name" value="${esc(c.name)}" required></label>
        <label class="field" for="f-city">Település<input id="f-city" data-k="city" value="${esc(c.city)}"></label>
        <label class="field" for="f-address">Cím<input id="f-address" data-k="address" value="${esc(c.address)}"></label>
        <label class="field" for="f-rite">Rítus<select id="f-rite" data-k="rite"><option value="rk" ${c.rite === "rk" ? "selected" : ""}>római katolikus</option><option value="gk" ${c.rite === "gk" ? "selected" : ""}>görögkatolikus</option></select></label>
        <label class="field" for="f-imp" title="A térkép kicsinyítve csak a legfontosabb templomokat mutatja; ezzel előrébb vagy hátrébb sorolhatod ezt a templomot.">Kiemelés a térképen<select id="f-imp" data-k="importance_manual">
          <option value="" ${c.importance_manual == null || c.importance_manual === "" ? "selected" : ""}>Automatikus${c.importance_auto != null ? " (" + c.importance_auto + ")" : ""}</option>
          ${[[100, "Kiemelt – mindig látszik"], [75, "Fontos"], [50, "Átlagos"], [20, "Háttérben"]].map(([v, t]) => `<option value="${v}" ${String(c.importance_manual) === String(v) ? "selected" : ""}>${t}</option>`).join("")}
        </select></label>
        <label class="field" for="f-lat">Szélesség (lat)<input id="f-lat" data-k="lat" inputmode="decimal" value="${esc(c.lat)}"></label>
        <label class="field" for="f-lon">Hosszúság (lon)<input id="f-lon" data-k="lon" inputmode="decimal" value="${esc(c.lon)}"></label>
        <label class="field" for="f-website">Weboldal<input id="f-website" data-k="website" value="${esc(c.website)}"></label>
        <label class="field" for="f-phone">Telefon<input id="f-phone" data-k="phone" value="${esc(c.phone)}"></label>
      </div>
      <label class="field" for="f-notes">Belső megjegyzés (nem nyilvános)<textarea id="f-notes" data-k="notes">${esc(c.notes)}</textarea></label>
      <div class="row">
        <label class="check" for="f-pub"><input type="checkbox" id="f-pub" data-k="published" ${c.published ? "checked" : ""}>Látszik a nyilvános térképen</label>
        ${osm ? `<a class="btn" href="${osm}" target="_blank" rel="noopener">Hely ellenőrzése a térképen</a>` : ""}
      </div>
      <label class="check" for="f-approx"><input type="checkbox" id="f-approx" data-k="location_approx" ${c.location_approx ? "checked" : ""}>A hely pontosítandó (a nyilvános oldalon figyelmeztetés látszik)</label>
    </div>

    <div class="block"><h3>Megjegyzés a miserendhez</h3>
      <label class="field" for="f-snote">Nyilvános megjegyzés (pl. „Adventben a hétköznapi misék reggel 6-kor”). Webcímek kattinthatók lesznek.<textarea id="f-snote" data-k="schedule_note" rows="4">${esc(c.schedule_note)}</textarea></label>
      ${c.schedule_source ? `<p class="muted" style="margin:0">Az időpontok forrása: <b>${esc(SOURCE_NAMES[c.schedule_source] || c.schedule_source)}</b>${c.schedule_updated ? `, frissítve ${esc(c.schedule_updated)}` : ""}. Az import újrafuttatásakor frissülnek, hacsak nem zárolod.</p>` : ""}
      <label class="check" for="f-lock"><input type="checkbox" id="f-lock" data-k="schedule_locked" ${c.schedule_locked ? "checked" : ""}>Kézzel ellenőrzött miserend – az import ne írja felül</label>
    </div>

    <div class="block"><h3>Nyitvatartás</h3>
      <label class="check" for="f-only"><input type="checkbox" id="f-only" data-k="open_only_services" ${c.open_only_services ? "checked" : ""}>Csak a szertartások idején van nyitva</label>
      <div class="rows">${c.hours.map((h, i) => `<div class="srow">${daysHTML(h.days, "hours." + i)}
        ${timeField(`h-o-${i}`, "Nyit", `data-l="hours" data-i="${i}" data-f="opens"`, h.opens)}
        ${timeField(`h-c-${i}`, "Zár", `data-l="hours" data-i="${i}" data-f="closes"`, h.closes)}
        <button type="button" class="icon-btn" data-del="hours" data-i="${i}" aria-label="Sor törlése">Törlés</button></div>`).join("")}</div>
      <div><button type="button" class="btn" data-add="hours">+ Nyitvatartási sor</button></div>
    </div>

    <div class="block"><h3>Rendszeres alkalmak</h3>
      <p class="muted" style="margin:0">Ha nyáron és télen eltér egy időpont, vegyél fel két sort, és az „Időszak” mezőben jelöld, melyik mikor érvényes (nyár = nyári időszámítás). Ami egész évben ugyanaz, maradjon „Egész évben”.</p>
      <div class="rows">${c.services.map(serviceRow).join("")}</div>
      <div class="row"><button type="button" class="btn" data-add="services" data-kind="mass">+ Mise</button><button type="button" class="btn" data-add="services" data-kind="confession">+ Gyóntatás</button><button type="button" class="btn" data-add="services" data-kind="adoration">+ Szentségimádás</button><button type="button" class="btn" data-add="services" data-kind="rorate">+ Rorate (advent)</button></div>
    </div>

    ${feastsHTML(c)}

    <div class="block"><h3>Események</h3>
      <div class="rows">${c.events.map((e, i) => `<div class="srow">
        <label class="field" for="e-d-${i}">Dátum<input type="date" id="e-d-${i}" data-l="events" data-i="${i}" data-f="date" value="${esc(e.date)}"></label>
        ${timeField(`e-s-${i}`, "Időpont", `data-l="events" data-i="${i}" data-f="start"`, e.start)}
        <label class="field note" for="e-t-${i}">Cím<input id="e-t-${i}" data-l="events" data-i="${i}" data-f="title" value="${esc(e.title)}" placeholder="pl. Búcsúi szentmise"></label>
        <label class="field note" for="e-n-${i}">Megjegyzés<input id="e-n-${i}" data-l="events" data-i="${i}" data-f="note" value="${esc(e.note)}"></label>
        <button type="button" class="icon-btn" data-del="events" data-i="${i}" aria-label="Sor törlése">Törlés</button></div>`).join("")}</div>
      <div><button type="button" class="btn" data-add="events">+ Esemény</button></div>
    </div>

    <div class="bar">
      <button class="btn primary" type="submit" id="save">Mentés</button>
      ${c.id && isAdmin ? `<button type="button" class="btn" id="merge-open">Összevonás egy másik templommal…</button><button type="button" class="btn danger" id="del">Templom törlése</button>` : ""}
      <span class="msg" id="emsg" role="status"></span>
    </div>
  </form>
  <section class="card-box merge" id="merge" hidden></section>`;
  document.scrollingElement.scrollTop = scroll;
  bindEditor();
}
function bindEditor() {
  const c = A.draft, f = $("#ed");
  const setVal = el => {
    if (el.dataset.k) c[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value;
    else if (el.dataset.l) c[el.dataset.l][+el.dataset.i][el.dataset.f] = el.value;
    else if (el.dataset.feast) c.feasts[el.dataset.feast].rows[+el.dataset.i][el.dataset.f] = el.value;
  };
  f.addEventListener("input", e => { A.dirty = true; setVal(e.target); e.target.classList.remove("bad"); if (e.target.id === "f-lock") A.lockTouched = true; });
  // Tidy a time when leaving the field: "1730" → "17:30"; mark it if it still isn't a valid 24-hour time.
  f.addEventListener("focusout", e => {
    const el = e.target; if (!el.classList?.contains("hhmm")) return;
    el.value = normTime(el.value); setVal(el);
    el.classList.toggle("bad", !!el.value && !TIME_RE.test(el.value));
  });
  f.addEventListener("change", e => {
    const el = e.target;
    if (el.dataset.period !== undefined) { A.dirty = true; const r = c.services[+el.dataset.period];
      if (el.value === "custom") { r.period = "all"; r.valid ||= ""; r.customRange = true; } else { r.period = el.value; if (el.value === "all") r.valid = ""; r.customRange = false; }
      return renderEditor(); }
    if (el.dataset.every !== undefined) { A.dirty = true; const r = c.services[+el.dataset.every]; r.every = +el.value; if (r.every < 2) r.anchor = ""; return renderEditor(); }
    if (el.dataset.anchor !== undefined) { A.dirty = true; c.services[+el.dataset.anchor].anchor = el.value; return; }
    if (el.dataset.lang !== undefined) { A.dirty = true; const r = c.services[+el.dataset.lang];
      r.tags = [...(r.tags || []).filter(t => !t.startsWith("lang:")), ...(el.value ? ["lang:" + el.value] : [])]; return; }
    if (el.dataset.valid !== undefined) { const v = textToValid(el.value); el.classList.toggle("bad", v === null); if (v !== null) { c.services[+el.dataset.valid].valid = v; el.value = validToText(v); } A.dirty = true; return; }
    if (el.dataset.feastmode) { A.dirty = true; const fe = c.feasts[el.dataset.feastmode]; fe.mode = el.value; if (fe.mode === "custom" && !fe.rows.length) fe.rows.push({ kind: "mass", start: "", end: "", note: "" }); renderEditor(); }
    else if (el.dataset.f === "kind") renderEditor();
  });
  f.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.tag !== undefined) { const row = c.services[+b.dataset.tag], t = b.dataset.t; row.tags ||= [];
      row.tags = row.tags.includes(t) ? row.tags.filter(x => x !== t) : [...row.tags, t]; b.setAttribute("aria-pressed", row.tags.includes(t)); A.dirty = true; return; }
    if (b.dataset.weeks !== undefined) { const row = c.services[+b.dataset.weeks], n = +b.dataset.n; row.weeks ||= [];
      row.weeks = row.weeks.includes(n) ? row.weeks.filter(x => x !== n) : [...row.weeks, n].sort((a, z) => a - z); A.dirty = true; return renderEditor(); }
    if (b.dataset.days) { const [list, i] = b.dataset.days.split("."), d = +b.dataset.d, row = c[list][+i];
      row.days = row.days.includes(d) ? row.days.filter(x => x !== d) : [...row.days, d].sort((a, z) => a - z);
      b.setAttribute("aria-pressed", row.days.includes(d)); A.dirty = true; return; }
    if (b.dataset.add) { A.dirty = true;
      if (b.dataset.add === "hours") c.hours.push({ days: [1, 2, 3, 4, 5, 6, 0], opens: "08:00", closes: "18:00" });
      if (b.dataset.add === "services") c.services.push({ kind: b.dataset.kind, days: b.dataset.kind === "rorate" ? [1, 2, 3, 4, 5, 6] : [0], start: b.dataset.kind === "rorate" ? "06:00" : "", end: "", note: b.dataset.kind === "rorate" ? "Rorate" : "", period: "all" });
      if (b.dataset.add === "events") c.events.push({ date: "", start: "", title: "", note: "" });
      return renderEditor(); }
    if (b.dataset.del) { A.dirty = true; c[b.dataset.del].splice(+b.dataset.i, 1); return renderEditor(); }
    if (b.id === "add-feast-btn") { const k = $("#add-feast").value; if (k) { A.dirty = true; c.feasts[k] = { mode: "sunday", rows: [] }; renderEditor(); } return; }
    if (b.dataset.delfeast) { A.dirty = true; delete c.feasts[b.dataset.delfeast]; return renderEditor(); }
    if (b.dataset.addfeastrow) { A.dirty = true; c.feasts[b.dataset.addfeastrow].rows.push({ kind: "mass", start: "", end: "", note: "" }); return renderEditor(); }
    if (b.dataset.delfeastrow) { A.dirty = true; c.feasts[b.dataset.delfeastrow].rows.splice(+b.dataset.i, 1); return renderEditor(); }
  });
  f.addEventListener("submit", e => { e.preventDefault(); save(); });
  $("#del")?.addEventListener("click", delChurch);
  $("#merge-open")?.addEventListener("click", openMerge);
}
function validate(c) {
  if (!c.name.trim()) return "Add meg a templom nevét.";
  const lat = parseFloat(String(c.lat).replace(",", ".")), lon = parseFloat(String(c.lon).replace(",", "."));
  if (!(lat >= 45 && lat <= 49) || !(lon >= 16 && lon <= 23.5)) return "A koordináták nem Magyarország területére esnek. Ellenőrizd a szélességet és a hosszúságot.";
  const okT = (t, where) => !t || TIME_RE.test(t) ? "" : `${where}: a(z) „${t}” nem érvényes időpont. Írd 24 órás formában, pl. 17:30.`;
  for (const [i, h] of c.hours.entries()) {
    const w = `Nyitvatartás, ${i + 1}. sor`;
    if (!h.days.length) return `${w}: jelölj ki legalább egy napot.`;
    const e = okT(h.opens, w) || okT(h.closes, w); if (e) return e;
    if (!h.opens || !h.closes || h.opens >= h.closes) return `${w}: a nyitás legyen a zárás előtt.`;
  }
  for (const [i, s] of c.services.entries()) {
    const w = `Rendszeres alkalmak, ${i + 1}. sor`;
    if (!s.days.length) return `${w}: jelölj ki legalább egy napot.`;
    if (!s.start) return `${w}: add meg a kezdés idejét.`;
    const e = okT(s.start, w) || okT(s.end, w); if (e) return e;
    if (s.end && s.end <= s.start) return `${w}: a vége legyen a kezdés után.`;
    const vEl = document.getElementById(`s-v-${i}`);
    if (vEl && textToValid(vEl.value) === null) return `${w}: az időszakot így írd: 05.01–08.31 (több időszak vesszővel).`;
    if (s.period === "all" && s.customRange && !s.valid) return `${w}: add meg az egyedi időszakot, pl. 07.01–08.31.`;
    if (+s.every > 1 && !s.anchor) return `${w}: add meg egy nap dátumát, amikor biztosan van (ettől számoljuk a ${EVERY_OPTS[s.every].toLowerCase()} rendet).`;
    if (+s.every > 1 && !s.days.includes(new Date(s.anchor + "T12:00").getDay())) return `${w}: az „Egyik alkalom napja” nem a kijelölt napok egyikére esik.`;
  }
  for (const [k, f] of Object.entries(c.feasts)) {
    const w = window.LitCal.FEAST_BY_KEY[k].name;
    if (f.mode !== "custom") continue;
    if (!f.rows.length) return `${w}: adj meg legalább egy időpontot, vagy válaszd a vasárnapi miserendet.`;
    for (const [i, r] of f.rows.entries()) {
      if (!r.start) return `${w}, ${i + 1}. sor: add meg a kezdés idejét.`;
      const e = okT(r.start, w) || okT(r.end, w); if (e) return e;
      if (r.end && r.end <= r.start) return `${w}, ${i + 1}. sor: a vége legyen a kezdés után.`;
    }
  }
  for (const [i, e] of c.events.entries()) {
    if (!e.date || !e.title.trim()) return `Események, ${i + 1}. sor: a dátum és a cím kötelező.`;
    const er = okT(e.start, `Események, ${i + 1}. sor`); if (er) return er;
  }
  return "";
}
async function save() {
  const c = A.draft, m = $("#emsg");
  const err = validate(c); if (err) { m.textContent = err; m.className = "msg err"; return; }
  $("#save").disabled = true; m.textContent = "Mentés…"; m.className = "msg";
  const regular = c.services.map(s => ({ kind: s.kind, days: s.days, start: s.start, end: s.kind === "mass" || s.kind === "rorate" ? "" : (s.end || ""), note: s.note,
    period: s.kind === "rorate" ? "all" : s.period, valid: s.kind === "rorate" ? "" : (s.valid || ""), weeks: s.weeks || [],
    every: +s.every > 1 ? +s.every : null, anchor: +s.every > 1 ? s.anchor : "", tags: s.kind === "mass" || s.kind === "rorate" ? (s.tags || []) : [] }));
  const feastRows = Object.entries(c.feasts).filter(([, f]) => f.mode === "custom")
    .flatMap(([k, f]) => f.rows.map(r => ({ kind: r.kind, days: [], start: r.start, end: r.kind === "mass" ? "" : (r.end || ""), note: r.note, period: "all", feast: k })));
  const p = { id: c.id, name: c.name.trim(), city: c.city.trim(), address: (c.address || "").trim(), rite: c.rite,
    lat: parseFloat(String(c.lat).replace(",", ".")), lon: parseFloat(String(c.lon).replace(",", ".")),
    website: c.website || "", phone: c.phone || "", notes: c.notes || "", open_only_services: !!c.open_only_services, published: !!c.published,
    feast_sunday: Object.entries(c.feasts).filter(([, f]) => f.mode === "sunday").map(([k]) => k),
    importance_manual: c.importance_manual == null || c.importance_manual === "" ? "" : Number(c.importance_manual),
    schedule_note: (c.schedule_note || "").trim(), location_approx: !!c.location_approx, schedule_locked: !!c.schedule_locked,
    hours: c.hours, services: [...regular, ...feastRows], events: c.events };
  // Times of an imported church changed by hand: lock them so the next import does not undo the edit.
  let autoLocked = false;
  if (c.schedule_source && !c.schedule_locked && !A.lockTouched && JSON.stringify([c.services, c.feasts]) !== A.svcSnapshot) { p.schedule_locked = true; c.schedule_locked = true; autoLocked = true; }
  const { data, error } = await sb.rpc("save_church", { p });
  $("#save").disabled = false;
  if (error) { m.textContent = "Nem sikerült menteni: " + error.message; m.className = "msg err"; return; }
  A.dirty = false;
  m.textContent = "Mentve. A nyilvános oldalon frissítés után látszik." + (autoLocked ? " Az időpontokat kézzel módosítottad, ezért zároltuk őket az import elől." : ""); m.className = "msg ok";
  A.svcSnapshot = JSON.stringify([c.services, c.feasts]); if (autoLocked) { const cb = $("#f-lock"); if (cb) cb.checked = true; }
  if (!c.id) { c.id = data; A.sel = data; }
  loadList();
}
async function delChurch() {
  const c = A.draft;
  if (!window.confirm(`Biztosan törlöd: ${c.name}? Az időpontjai és eseményei is törlődnek. Ez nem vonható vissza.`)) return;
  const { error } = await sb.from("churches").delete().eq("id", c.id);
  if (error) { $("#emsg").textContent = "Nem sikerült törölni: " + error.message; $("#emsg").className = "msg err"; return; }
  A.draft = null; A.sel = null; A.dirty = false; renderChurches();
}

/* ---------- Merging duplicates ---------- */
// The same church in the database twice (an import put it beside the map's church, or the map has it twice).
const mkm = (a, b) => { const R = Math.PI / 180, h = Math.sin((b.lat - a.lat) * R / 2) ** 2 + Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.sin((b.lon - a.lon) * R / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
const distText = d => d < 1 ? Math.round(d * 1000) + " m" : d.toFixed(1).replace(".", ",") + " km";
async function openMerge() {
  const box = $("#merge"), c = A.draft;
  if (A.dirty) { box.hidden = false; box.innerHTML = `<p class="msg err" style="margin:0">Előbb mentsd el a módosításokat, utána vond össze.</p>`; return; }
  box.hidden = false;
  box.innerHTML = `<h3 class="mh">Melyik templommal azonos?</h3>
    <label class="search" for="mq"><input id="mq" type="search" placeholder="Keresés névre (üresen: a legközelebbiek)" autocomplete="off"></label>
    <ul class="clist" id="mlist"><li class="muted" style="padding:8px">Betöltés…</li></ul><div id="mcmp"></div>`;
  box.scrollIntoView({ behavior: "smooth", block: "start" });
  const load = async () => {
    const term = fold($("#mq").value.trim()).replace(/[%,()*]/g, " ").trim();
    let q = sb.from("admin_church_list").select("id,name,city,address,lat,lon,n_services,schedule_source,location_approx,created_by,n_events,n_pending").neq("id", c.id).limit(40);
    if (term) for (const w of term.split(/\s+/)) q = q.like("search", `%${w}%`);
    else q = q.gte("lat", c.lat - 0.03).lte("lat", c.lat + 0.03).gte("lon", c.lon - 0.045).lte("lon", c.lon + 0.045);
    const { data, error } = await q;
    if (error) { $("#mlist").innerHTML = `<li class="msg err">${esc(error.message)}</li>`; return; }
    const list = (data || []).map(o => ({ ...o, d: mkm(c, o) })).sort((a, b) => a.d - b.d).slice(0, 15);
    $("#mlist").innerHTML = list.map(o => `<li><button type="button" data-mid="${o.id}"><span class="nm">${esc(o.name)}</span><span class="sub"><span>${esc(o.city || "–")}</span><span>${distText(o.d)}</span><span>${o.n_services ? o.n_services + " időpont" : "nincs időpont"}</span>${o.location_approx ? `<span class="warn">hely pontosítandó</span>` : ""}${o.schedule_source ? "<span>import</span>" : ""}</span></button></li>`).join("") || `<li class="muted" style="padding:8px">Nincs találat.</li>`;
    $("#mlist").querySelectorAll("[data-mid]").forEach(b => b.addEventListener("click", () => compare(list.find(o => o.id === +b.dataset.mid))));
  };
  let t; $("#mq").addEventListener("input", () => { clearTimeout(t); t = setTimeout(load, 250); });
  load();
}
function compare(o) {
  const c = A.draft, me = { id: c.id, name: c.name, city: c.city, lat: +c.lat, lon: +c.lon, n_services: c.services.length + Object.values(c.feasts).reduce((n, f) => n + f.rows.length, 0), location_approx: c.location_approx, schedule_source: c.schedule_source };
  // Defaults: keep the place that is not approximate; take the times from the one that has them.
  const keepOther = me.location_approx && !o.location_approx;
  const timesFromOther = o.n_services > me.n_services;
  const opt = (name, v, label, checked) => `<label class="check"><input type="radio" name="${name}" value="${v}" ${checked ? "checked" : ""}>${label}</label>`;
  const who = x => `${esc(x.name)}${x.city ? ` (${esc(x.city)})` : ""}`;
  $("#mcmp").innerHTML = `<div class="cmp">
    <p style="margin:0"><b>${who(me)}</b> és <b>${who(o)}</b> — ${distText(mkm(me, o))} egymástól.</p>
    <fieldset><legend>Melyik helye pontos a térképen? Ez marad meg.</legend>
      ${opt("keep", "me", `Ez: ${who(me)}${me.location_approx ? " – hely pontosítandó" : ""}`, !keepOther)}${opt("keep", "other", `A másik: ${who(o)}${o.location_approx ? " – hely pontosítandó" : ""}`, keepOther)}</fieldset>
    <fieldset><legend>Melyik nevet használjuk?</legend>${opt("name", "me", esc(me.name), true)}${opt("name", "other", esc(o.name), false)}</fieldset>
    <fieldset><legend>Kinek az időpontjai maradjanak?</legend>${opt("times", "me", `${esc(me.name)} – ${me.n_services} időpont${me.schedule_source ? " (import)" : ""}`, !timesFromOther)}${opt("times", "other", `${esc(o.name)} – ${o.n_services} időpont${o.schedule_source ? " (import)" : ""}`, timesFromOther)}</fieldset>
    <p class="muted" style="margin:0">Az eseményeket, javaslatokat és plébániai szerkesztőket mindkettőtől átvesszük. A másik bejegyzés törlődik. Az import a jövőben a megmaradt templomot frissíti.</p>
    <div class="row"><button type="button" class="btn primary" id="do-merge">Összevonás</button><button type="button" class="btn" id="cancel-merge">Mégse</button><span class="msg" id="mmsg" role="status"></span></div>
  </div>`;
  $("#cancel-merge").addEventListener("click", () => { $("#merge").hidden = true; });
  $("#do-merge").addEventListener("click", async () => {
    const pick = n => $(`#mcmp input[name="${n}"]:checked`).value;
    const keepMe = pick("keep") === "me", keepId = keepMe ? me.id : o.id, dropId = keepMe ? o.id : me.id;
    const nameFrom = (pick("name") === "me") === keepMe ? "keep" : "drop";
    const scheduleFrom = (pick("times") === "me") === keepMe ? "keep" : "drop";
    $("#do-merge").disabled = true; $("#mmsg").textContent = "Összevonás…"; $("#mmsg").className = "msg";
    const { data, error } = await sb.rpc("merge_churches", { keep_id: keepId, drop_id: dropId, schedule_from: scheduleFrom, name_from: nameFrom });
    if (error) { $("#do-merge").disabled = false; $("#mmsg").textContent = "Nem sikerült: " + error.message; $("#mmsg").className = "msg err"; return; }
    A.dirty = false; await openChurch(data); loadList();
    const m = $("#emsg"); if (m) { m.textContent = "Összevonva. Ez a megmaradt templom."; m.className = "msg ok"; }
  });
}

/* ---------- Suggestions ---------- */
async function refreshSuggCount() {
  const { count } = await sb.from("suggestions").select("id", { count: "exact", head: true }).eq("status", "pending");
  $("#sugg-count").textContent = count ? String(count) : "";
}
async function renderSuggestions() {
  main.innerHTML = `<div class="suglist">
    <div class="row"><h2 style="margin-right:auto">Beküldött javaslatok</h2>
      <label class="field" for="sst" style="flex:0 1 200px">Állapot<select id="sst">
        <option value="pending" ${A.suggStatus === "pending" ? "selected" : ""}>Döntésre vár</option>
        <option value="approved" ${A.suggStatus === "approved" ? "selected" : ""}>Elfogadva</option>
        <option value="rejected" ${A.suggStatus === "rejected" ? "selected" : ""}>Elutasítva</option></select></label></div>
    <div id="slist" class="suglist"><p class="muted">Betöltés…</p></div></div>`;
  $("#sst").addEventListener("change", e => { A.suggStatus = e.target.value; renderSuggestions(); });
  const { data, error } = await sb.from("suggestions").select("*, churches(id,name,city)").eq("status", A.suggStatus).order("created_at", { ascending: false }).limit(100);
  if (error) { $("#slist").innerHTML = `<p class="msg err">Nem sikerült betölteni: ${esc(error.message)}</p>`; return; }
  $("#slist").innerHTML = (data || []).map(s => `<article class="sugg">
      <div class="meta"><span class="pill st-${esc(s.status)}">${s.status === "pending" ? "Döntésre vár" : s.status === "approved" ? "Elfogadva" : "Elutasítva"}</span>
        <span>${esc(TYPES[s.type] || s.type)}</span><span>${new Date(s.created_at).toLocaleString("hu-HU", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span></div>
      <strong>${esc(s.churches ? s.churches.name + " (" + s.churches.city + ")" : "Ismeretlen templom")}</strong>
      <p>${esc(s.text)}</p>
      ${s.contact ? `<p class="muted">Kapcsolat: ${esc(s.contact)}</p>` : ""}
      <div class="actions">
        ${s.churches ? `<button class="btn" data-open="${s.churches.id}">Templom megnyitása</button>` : ""}
        ${s.status === "pending" ? `<button class="btn primary" data-act="approved" data-id="${s.id}">Elfogadás</button><button class="btn" data-act="rejected" data-id="${s.id}">Elutasítás</button>` : ""}
      </div></article>`).join("") || `<p class="muted">Nincs ilyen javaslat.</p>`;
  $("#slist").querySelectorAll("[data-open]").forEach(b => b.addEventListener("click", () => { setTab("churches"); openChurch(+b.dataset.open); }));
  $("#slist").querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", async () => {
    b.disabled = true;
    const { error } = await sb.from("suggestions").update({ status: b.dataset.act, decided_at: new Date().toISOString(), decided_by: A.user.id }).eq("id", b.dataset.id);
    if (error) { b.disabled = false; b.textContent = "Nem sikerült, próbáld újra"; return; }
    refreshSuggCount(); renderSuggestions();
  }));
}
window.addEventListener("beforeunload", e => { if (A.dirty) { e.preventDefault(); e.returnValue = ""; } });
