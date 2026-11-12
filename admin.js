"use strict";
/* Harangszó admin panel: a rail of sections, the church list, and the open church, whose week is the shared
   schedule editor (schedule-editor.js, admin: true). All permissions are enforced by the database (row level
   security); this page only hides what the signed-in person cannot change anyway. */

const CFG = window.HARANGSZO_CONFIG || {};
const SE = window.ScheduleEditor;
const real = v => typeof v === "string" && v && !v.startsWith("__");
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const app = $("#app"), main = $("#main"), rail = $("#rail"), listCol = $("#listcol"), bar = $("#savebar");
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_SHORT = { 0: "V", 1: "H", 2: "K", 3: "Sze", 4: "Cs", 5: "P", 6: "Szo" };
const DAY_NAME = ["Vasárnap", "Hétfő", "Kedd", "Szerda", "Csütörtök", "Péntek", "Szombat"];
const KINDS = { mass: "Mise", confession: "Gyóntatás", adoration: "Szentségimádás", rorate: "Rorate (advent)", prayer: "Imaóra, ájtatosság" };
const SOURCE_NAMES = { szfvar: "Székesfehérvári Egyházmegye miserendje", miserend: "miserend.hu" };
const SOURCE_TAG = { szfvar: "egyházmegye", miserend: "miserend.hu" };
const TYPES = { conf: "Gyóntatási időpont", mass: "Mise időpont", hours: "Nyitvatartás", event: "Esemény", place: "Hely vagy egyéb" };
const MON = ["jan.", "febr.", "márc.", "ápr.", "máj.", "jún.", "júl.", "aug.", "szept.", "okt.", "nov.", "dec."];
const hm = t => t ? String(t).slice(0, 5) : "";
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SEARCH_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;

if (!real(CFG.supabaseUrl) || !real(CFG.supabaseAnonKey) || !window.supabase) {
  main.innerHTML = `<div class="ui-card ad-narrow"><h1 class="ad-ptitle">Még nincs beállítva</h1><p>Az adatbázis (Supabase) adatai hiányoznak a <code>config.js</code> fájlból. Add meg a <code>SUPABASE_URL</code> és <code>SUPABASE_PUBLISHABLE_KEY</code> titkokat a GitHub-tárolóban, majd futtasd újra a közzétételt. Lépések: README.</p></div>`;
  throw new Error("not configured");
}
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
// page: the rail's section; view: list or church on phones; ctab: the open church's tab; changes: edits since the last save.
const A = { user: null, staff: null, myChurches: null, page: "churches", view: "list", ctab: "sched", q: "", f: null, list: [], total: 0, sel: null, draft: null,
  meta: null, nearby: [], parishIds: new Set(), suggStatus: "pending", dirty: false, changes: 0, se: null };

/* ---------- Small helpers ---------- */
const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const dayDiff = t => { const d = new Date(t); return Math.round((today() - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5); };
const clock = d => d.toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" });
// "ma 14:05", "tegnap 21:14", "okt. 20. 09:15" (with the year when it is not this year)
function whenText(t) {
  const d = new Date(t); if (isNaN(d)) return "";
  const diff = dayDiff(d);
  if (diff === 0) return "ma " + clock(d);
  if (diff === 1) return "tegnap " + clock(d);
  return (d.getFullYear() !== today().getFullYear() ? d.getFullYear() + ". " : "") + `${MON[d.getMonth()]} ${d.getDate()}. ${clock(d)}`;
}
const ago = t => { const n = dayDiff(t); return n <= 0 ? "ma" : n === 1 ? "tegnap" : n < 30 ? `${n} napja` : whenText(t); };
const fullWhen = t => new Date(t).toLocaleString("hu-HU", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const shortWhen = t => new Date(t).toLocaleString("hu-HU", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const tag = (cls, text, title = "") => `<span class="ui-tag ${cls}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;
const narrow = () => matchMedia("(max-width: 719.98px)").matches;
let toastT;
function toast(text) {
  const t = $("#toast"); t.textContent = text; t.classList.add("on");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), text.length > 40 ? 6000 : 3000);
}

/* ---------- Auth ---------- */
function showShell(on) { rail.hidden = !on; listCol.hidden = !on; if (!on) { app.dataset.page = "login"; syncBar(); } }
function renderLogin(msg = "") {
  unmountEditor(); showShell(false); $("#who").innerHTML = "";
  main.innerHTML = `<form class="ui-card ad-narrow" id="login">
    <h1 class="ad-ptitle">Belépés</h1>
    <label class="ui-field" for="em"><span>E-mail</span><input id="em" type="email" autocomplete="username" required></label>
    <label class="ui-field" for="pw"><span>Jelszó</span><input id="pw" type="password" autocomplete="current-password" required></label>
    <button class="ui-btn primary" type="submit">Belépés</button>
    <p class="ad-msg err" id="lmsg" role="alert">${esc(msg)}</p>
    <p class="ad-muted">Szerkesztői fiókot az adminisztrátor hoz létre.</p>
  </form>`;
  $("#login").addEventListener("submit", async e => {
    e.preventDefault(); $("#lmsg").textContent = "Belépés…"; $("#lmsg").className = "ad-msg";
    const { error } = await sb.auth.signInWithPassword({ email: $("#em").value.trim(), password: $("#pw").value });
    if (error) { $("#lmsg").textContent = error.message === "Invalid login credentials" ? "Hibás e-mail-cím vagy jelszó." : "Nem sikerült belépni: " + error.message; $("#lmsg").className = "ad-msg err"; }
  });
}
async function afterLogin(user) {
  A.user = user;
  const { data: staff } = await sb.from("staff").select("role,display_name").eq("user_id", user.id).maybeSingle();
  A.staff = staff;
  const who = `<span class="em">${esc(user.email || staff?.display_name || "")}${staff ? " · " + (staff.role === "admin" ? "admin" : "plébánia") : ""}</span><button class="ui-btn quiet" type="button" data-logout>Kijelentkezés</button>`;
  $("#who").innerHTML = who;
  if (!staff) {
    showShell(false);
    main.innerHTML = `<div class="ui-card ad-narrow wide"><h1 class="ad-ptitle">Nincs szerkesztői jogod</h1>
      <p>Be vagy jelentkezve, de a fiókod még nincs felvéve szerkesztőnek. Kérd meg az adminisztrátort, hogy vegyen fel.</p>
      <p class="ad-muted">Ha te vagy az első adminisztrátor, futtasd ezt a Supabase SQL Editorban:</p>
      <code class="snip">insert into public.staff (user_id, role, display_name)\nvalues ('${esc(user.id)}', 'admin', '${esc(user.email)}');</code>
      <p class="ad-muted">Utána frissítsd ezt az oldalt.</p><p class="ad-me">${who}</p></div>`;
    return;
  }
  if (staff.role === "parish") {
    showShell(false);
    main.innerHTML = `<div class="ui-card ad-narrow"><h1 class="ad-ptitle">A plébániák felülete máshol van</h1>
      <p>A templomod miserendjét a plébániáknak készült, egyszerűbb oldalon szerkesztheted.</p>
      <a class="ui-btn primary" href="plebania.html">Tovább a plébániai felületre</a><p class="ad-me">${who}</p></div>`;
    return;
  }
  try { localStorage.setItem("harangszo.notrack", "1"); } catch (e) { } // this device's own map visits stay out of the statistics
  showShell(true);
  refreshSuggCount();
  setTab(A.page);
}
document.addEventListener("click", e => { if (e.target.closest("[data-logout]")) sb.auth.signOut(); });
sb.auth.onAuthStateChange((_ev, session) => { session?.user ? (A.user?.id !== session.user.id && afterLogin(session.user)) : (A.user = null, renderLogin()); });
sb.auth.getSession().then(({ data }) => { if (!data.session) renderLogin(); });

/* ---------- Rail: Templomok · Javaslatok · Hozzáférések · Összevonás · Statisztika ---------- */
function setTab(t, { render = true } = {}) {
  A.page = t; app.dataset.page = t;
  rail.querySelectorAll("[data-page]").forEach(b => b.setAttribute("aria-pressed", b.dataset.page === t));
  if (render) renderTab();
  syncBar();
}
rail.addEventListener("click", e => {
  const b = e.target.closest("[data-page]"); if (!b) return;
  if (b.dataset.page === A.page && (A.page === "churches" || A.page === "merge")) return showList();
  setTab(b.dataset.page);
});
function renderTab() {
  if (A.page !== "churches") unmountEditor();
  ({ churches: renderChurches, sugg: renderSuggestions, access: renderAccess, merge: renderMergePage, stats: renderStats })[A.page]();
  main.scrollTop = 0;
}
// Phones: back from a church (or the merge panel) to the list, where it was.
function showList() { A.view = "list"; app.dataset.view = "list"; if (narrow()) window.scrollTo(0, A.listY || 0); }
function showChurchView() {
  if (narrow() && A.view === "list") A.listY = window.scrollY;
  A.view = "church"; app.dataset.view = "church";
  if (narrow()) window.scrollTo(0, 0);
}

/* ---------- Church list ---------- */
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
// The quick chips above the list: one value of an existing filter each; the rest sit in the Szűrők sheet.
const QUICK = [["times", "no", "Nincs időpont"], ["extra", "pending", "Javaslattal"], ["vis", "hidden", "Rejtett"], ["extra", "approx", "Hely bizonytalan"]];
const fold = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const defaultFilters = () => ({ rite: "", times: "", conf: "", extra: "", vis: "", imp: "", src: "", sort: "name" });
try { const f = JSON.parse(localStorage.getItem("harangszo-admin-filters") || "null"); if (f) A.f = { ...defaultFilters(), ...f }; } catch (e) { }
A.f ||= defaultFilters();
const activeFilterCount = () => Object.keys(FILTERS).filter(k => A.f[k]).length;
const saveFilters = () => { try { localStorage.setItem("harangszo-admin-filters", JSON.stringify(A.f)); } catch (e) { } };

function buildQuery(from) {
  let q = sb.from("admin_church_list").select("id,name,city,published,n_services,has_confession,has_rorate,has_feast,n_pending,importance,importance_manual,from_osm,location_approx,schedule_source,schedule_locked,near_duplicate,created_by", { count: "exact" });
  const term = fold(A.q.trim()).replace(/[%,()*]/g, " ").trim();
  // A number (or #number) finds that id as well as names and places containing it.
  if (/^#?\d+$/.test(term)) q = q.or(`id.eq.${term.replace("#", "")},search.like.*${term.replace("#", "")}*`);
  else if (term) for (const w of term.split(/\s+/)) q = q.like("search", `%${w}%`);
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
    A.parishIds.has(c.id) ? tag("t-open", "plébánia kezeli") : "",
    c.n_pending ? tag("t-conf", `${c.n_pending} javaslat`) : "",
    c.n_services ? "" : tag("t-warn", "nincs időpont"),
    c.location_approx ? tag("t-warn", "hely bizonytalan") : "",
    c.near_duplicate ? tag("t-warn", "duplikátum?", "130 m-en belül van egy másik templom is") : "",
    c.has_feast ? tag("t-ador", "ünnepi rend") : "",
    c.schedule_source ? tag("t-muted", (SOURCE_TAG[c.schedule_source] || c.schedule_source) + (c.schedule_locked ? " · zárolt" : ""), "Az időpontok importból származnak") : "",
    c.published ? "" : tag("t-muted", "rejtett"),
    A.f.sort === "imp" || A.f.imp ? tag("t-muted", `★ ${c.importance}${c.importance_manual != null ? " (kézi)" : ""}`, "Fontosság") : "",
  ].join("");
  return `<li><button type="button" class="ad-it" data-id="${c.id}" aria-current="${A.sel === c.id}"><span class="nm">${esc(c.name)}</span>
    <span class="sub"><span>${esc(c.city || "– település nincs megadva –")}</span>${tags}</span></button></li>`;
}
const renderItems = () => { $("#clist").innerHTML = A.list.map(itemHTML).join("") || `<li class="ad-empty">Nincs a szűrőknek megfelelő templom.</li>`; };
let listToken = 0;
async function loadList(append = false) {
  if (!$("#clist")) return;
  const token = ++listToken, from = append ? A.list.length : 0;
  if (!append) $("#clist").setAttribute("aria-busy", "true");
  const { data, error, count } = await buildQuery(from);
  if (token !== listToken) return;                 // a newer search has started; drop this answer
  $("#clist").removeAttribute("aria-busy");
  if (error) {
    const missing = /admin_church_list/.test(error.message || "") || error.code === "42P01" || error.code === "PGRST205";
    $("#clist").innerHTML = `<li class="ad-empty ad-msg err">${missing ? "A szűréshez futtasd a <code>supabase/migrations/004_admin_list.sql</code> fájlt a Supabase SQL Editorban." : "Nem sikerült betölteni: " + esc(error.message)}</li>`;
    $("#ccount").textContent = ""; $("#more").hidden = true; return;
  }
  A.list = append ? A.list.concat(data) : (data || []);
  A.total = count ?? A.list.length;
  renderItems();
  $("#ccount").textContent = `${A.total.toLocaleString("hu-HU")} találat`;
  const left = A.total - A.list.length;
  $("#more").hidden = left <= 0; $("#more").textContent = `Továbbiak betöltése (még ${left.toLocaleString("hu-HU")})`;
  // "plébánia kezeli": churches on this page that have an approved parish editor.
  const ids = A.list.map(c => c.id).filter(id => !A.parishIds.has(id));
  if (!ids.length) return;
  const { data: pe } = await sb.from("parish_editors").select("church_id").eq("role", "parish").in("church_id", ids);
  if (token !== listToken || !pe?.length) return;
  for (const r of pe) A.parishIds.add(r.church_id);
  renderItems();
}
function chipsHTML() {
  const n = activeFilterCount();
  return QUICK.map(([k, v, t]) => `<button type="button" class="ui-chip" data-qk="${k}" data-qv="${v}" aria-pressed="${A.f[k] === v}">${t}</button>`).join("") +
    `<button type="button" class="ui-chip" id="open-filters" aria-haspopup="dialog">⋯ Szűrők${n ? ` <span class="ad-fbadge" aria-label="${n} aktív szűrő">${n}</span>` : ""}</button>`;
}
function filtersSheetHTML() {
  const n = activeFilterCount();
  return `<header><h2 id="fs-title">Szűrők</h2><button type="button" class="ui-btn quiet" data-fclose>Kész</button></header>
    <div class="body"><div class="ad-fgrid">
      ${Object.entries(FILTERS).map(([k, f]) => `<label class="ui-field" for="f-${k}"><span>${f.label}</span><select id="f-${k}" data-filter="${k}">${Object.entries(f.opts).map(([v, t]) => `<option value="${v}" ${A.f[k] === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>`).join("")}
      <label class="ui-field" for="f-sort"><span>Rendezés</span><select id="f-sort" data-filter="sort">${Object.entries(SORTS).map(([v, t]) => `<option value="${v}" ${A.f.sort === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>
    </div></div>
    <footer><button type="button" class="ui-btn secondary" id="clear-filters" ${n || A.q ? "" : "disabled"}>Szűrők törlése</button><button type="button" class="ui-btn primary" data-fclose>Kész</button></footer>`;
}
function refreshFilterUI() {
  $("#chips").innerHTML = chipsHTML();
  const cl = $("#clear-filters"); if (cl) cl.disabled = !(activeFilterCount() || A.q);
}
function ensureListCol() {
  if ($("#clist")) return;
  const isAdmin = A.staff.role === "admin";
  listCol.innerHTML = `<label class="ad-search" for="cq">${SEARCH_ICON}<input id="cq" type="search" placeholder="Név, település, azonosító" aria-label="Keresés: név, település, azonosító" value="${esc(A.q)}" autocomplete="off"></label>
    <div class="ad-chips" id="chips" role="group" aria-label="Szűrők">${chipsHTML()}</div>
    <div class="ad-cnt"><span id="ccount" role="status"></span>${isAdmin ? `<button type="button" class="ui-btn quiet" id="new-church">＋ Új templom</button>` : ""}</div>
    <ul class="ad-clist" id="clist"><li class="ad-empty">Betöltés…</li></ul>
    <button type="button" class="ui-btn secondary" id="more" hidden></button>`;
  const sheet = document.createElement("dialog");
  sheet.className = "ui-sheet ad-fsheet"; sheet.id = "fsheet"; sheet.setAttribute("aria-labelledby", "fs-title");
  document.body.append(sheet);
  let t; $("#cq").addEventListener("input", e => { A.q = e.target.value; clearTimeout(t); t = setTimeout(() => { loadList(); refreshFilterUI(); }, 250); });
  $("#chips").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.id === "open-filters") { sheet.innerHTML = filtersSheetHTML(); sheet.showModal(); return; }
    const k = b.dataset.qk, v = b.dataset.qv;
    A.f[k] = A.f[k] === v ? "" : v; saveFilters(); loadList(); refreshFilterUI();
  });
  sheet.addEventListener("change", e => {
    const k = e.target.dataset.filter; if (!k) return;
    A.f[k] = e.target.value; saveFilters(); loadList(); refreshFilterUI();
  });
  sheet.addEventListener("click", e => {
    if (e.target === sheet) { const r = sheet.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return sheet.close(); }
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.fclose !== undefined) return sheet.close();
    if (b.id === "clear-filters") { A.f = defaultFilters(); A.q = ""; $("#cq").value = ""; saveFilters(); loadList(); sheet.innerHTML = filtersSheetHTML(); refreshFilterUI(); }
  });
  $("#more").addEventListener("click", () => loadList(true));
  $("#clist").addEventListener("click", e => { const b = e.target.closest("button[data-id]"); if (b) openChurch(+b.dataset.id); });
  $("#new-church")?.addEventListener("click", newChurch);
}
function markSelected() { $("#clist")?.querySelectorAll("button[data-id]").forEach(b => b.setAttribute("aria-current", +b.dataset.id === A.sel)); }
function renderChurches() {
  ensureListCol();
  loadList();
  if (A.draft) renderChurch();
  else main.innerHTML = `<div class="ui-empty"><strong>Válassz templomot</strong><p>A listából nyithatod meg${A.staff.role === "admin" ? ", vagy vegyél fel újat" : ""}.</p></div>`;
}

/* ---------- Opening a church ---------- */
const blankChurch = () => ({ id: null, schedule_note: "", schedule_locked: false, location_approx: false, schedule_source: null, importance_manual: "", importance_auto: null, name: "", city: "", address: "", rite: "rk", lat: "", lon: "", website: "", phone: "", notes: "", open_only_services: false, published: true, hours: [], services: [], feasts: {}, events: [] });
const noMeta = () => ({ sugg: [], editors: [], requests: [], edits: [] });
// The regular rules and feast schedules as auto-lock compares them: the rules in the editor's joined form, so
// splitting and joining them back (opening a tile and saving it unchanged) is no change.
const svcKey = c => JSON.stringify([SE.join(SE.split(c.services)), c.feasts]);
function newChurch() {
  if (A.dirty && !confirmDiscard()) return;
  A.sel = null; A.draft = blankChurch(); A.meta = noMeta(); A.nearby = [];
  setDirty(false); A.svcSnapshot = svcKey(A.draft); A.lockTouched = false;
  A.ctab = "data";
  markSelected();
  if (A.page !== "churches") setTab("churches", { render: false });
  showChurchView();
  renderChurch();
}
async function openChurch(id) {
  if (A.dirty && !confirmDiscard()) return;
  A.sel = id;
  markSelected(); showChurchView(); unmountEditor();
  main.innerHTML = `<p class="ad-loading">Betöltés…</p>`; main.scrollTop = 0;
  const { data, error } = await sb.from("churches").select("*, opening_hours(*), services!services_church_id_fkey(*), events(*)").eq("id", id).single();
  if (A.sel !== id) return;
  if (error) { main.innerHTML = `<div class="ad-page"><p class="ui-card ad-msg err">Nem sikerült megnyitni: ${esc(error.message)}</p></div>`; return; }
  const byTime = (a, b) => String(a.start_time).localeCompare(String(b.start_time));
  const KORDER = { mass: 0, rorate: 1, confession: 2, adoration: 3 };
  // Feast schedules: Sunday-rule feasts from churches.feast_sunday, custom ones from services rows with a feast key.
  const feasts = {};
  data.opening_hours ||= []; data.services ||= []; data.events ||= [];
  for (const k of data.feast_sunday || []) feasts[k] = { mode: "sunday", rows: [] };
  for (const s of data.services.filter(s => s.feast).sort(byTime)) {
    (feasts[s.feast] ||= { mode: "custom", rows: [] }).mode = "custom";
    feasts[s.feast].rows.push({ kind: s.kind, start: hm(s.start_time), end: hm(s.end_time), note: s.note || "", celebrant: s.celebrant || "", place: s.place || "" });
  }
  A.draft = { ...data,
    hours: data.opening_hours.map(h => ({ days: h.days, opens: hm(h.opens), closes: hm(h.closes) })),
    // The schedule editor's Rule shape (schedule-editor.js).
    services: data.services.filter(s => !s.feast).sort((a, b) => KORDER[a.kind] - KORDER[b.kind] || (a.period || "").localeCompare(b.period || "") || byTime(a, b))
      .map(s => ({ kind: s.kind, days: s.days, start: hm(s.start_time), end: hm(s.end_time), note: s.note || "", period: s.period || "all", valid: s.valid || "", weeks: s.weeks || [],
        every: s.every || 1, anchor: s.anchor || "", tags: s.tags || [],
        celebrant: s.celebrant || "", place: s.place || "", place_church_id: s.place_church_id || "", feast_skip: !!s.feast_skip })),
    feasts,
    events: data.events.sort((a, b) => String(a.date).localeCompare(String(b.date))).map(e => ({ date: e.date, start: hm(e.start_time), title: e.title, note: e.note || "" })) };
  setDirty(false); A.svcSnapshot = svcKey(A.draft); A.lockTouched = false;
  // Churches within ~5 km, for "held at another church" (plus any already chosen); and this church's
  // suggestions, editors, access requests and edit history.
  const near = async () => {
    const out = [];
    if (data.lat && data.lon) {
      const { data: nb } = await sb.from("churches").select("id,name,city,lat,lon").neq("id", id)
        .gte("lat", data.lat - 0.045).lte("lat", data.lat + 0.045).gte("lon", data.lon - 0.065).lte("lon", data.lon + 0.065).limit(80);
      out.push(...(nb || []).sort((a, b) => Math.hypot(a.lat - data.lat, (a.lon - data.lon) * .67) - Math.hypot(b.lat - data.lat, (b.lon - data.lon) * .67)));
    }
    const missingIds = [...new Set(A.draft.services.map(s => +s.place_church_id).filter(x => x && !out.some(n => n.id === x)))];
    if (missingIds.length) { const { data: ex } = await sb.from("churches").select("id,name,city").in("id", missingIds); out.push(...(ex || [])); }
    return out;
  };
  const [nearby, meta] = await Promise.all([near(), loadMeta(id)]);
  if (A.sel !== id) return;
  A.nearby = nearby; A.meta = meta;
  renderMain();
}
async function loadMeta(cid) {
  const [s, e, r, h] = await Promise.all([
    sb.from("suggestions").select("id,type,text,contact,status,created_at").eq("church_id", cid).eq("status", "pending").order("created_at", { ascending: false }).limit(20),
    sb.from("parish_editors").select("user_id,display_name,email,role").eq("church_id", cid).eq("role", "parish"),
    sb.from("access_requests").select("id,name,email,phone,position,message,status,created_at").eq("church_id", cid).order("created_at", { ascending: false }).limit(20),
    sb.from("church_edits").select("who,at,user_id").eq("church_id", cid).order("at", { ascending: false }).limit(50)]);
  return { sugg: s.data || [], editors: e.data || [], requests: r.data || [], edits: h.data || [], err: h.error?.message || "" };
}
// The viewer's confirm() works on this normal web page (it is not inside a Claude artifact).
function confirmDiscard() { return window.confirm("Van mentetlen módosításod ennél a templomnál. Eldobod?"); }
function renderMain() { A.page === "merge" ? renderMerge() : renderChurch(); }

/* ---------- Unsaved changes: the save bar ---------- */
function syncBar() {
  const err = !$("#saveerr").hidden;
  bar.classList.toggle("on", A.page === "churches" && !!A.draft && (A.dirty || err));
  $("#savestate").textContent = A.dirty ? `${A.changes} nem mentett változás` : "";
}
function setDirty(v) { A.dirty = v; if (!v) { A.changes = 0; showErr(""); } syncBar(); }
function showErr(t) { const e = $("#saveerr"); e.textContent = t; e.hidden = !t; syncBar(); }
// Each change counts once: a tap, a choice, or typing into one field until it loses focus.
let countedEl = null;
document.addEventListener("focusout", e => { if (e.target === countedEl) countedEl = null; });
function changed(el) {
  if (!el || el !== countedEl) { A.changes++; countedEl = el || null; }
  showErr(""); setDirty(true);
}
window.addEventListener("beforeunload", e => { if (A.dirty) { e.preventDefault(); e.returnValue = ""; } });
$("#bar-save").addEventListener("click", () => save());

/* ---------- The church: header, tabs ---------- */
const CTABS = { sched: "Miserend", feasts: "Ünnepek", events: "Események", data: "Adatok", editors: "Szerkesztők", history: "Előzmények" };
function headerMeta() {
  const c = A.draft, last = A.meta?.edits?.[0];
  return [esc(c.address || c.city || ""), c.id ? "#" + c.id : "", last ? `utoljára mentette: ${esc(last.who || "ismeretlen")}, ${esc(whenText(last.at))}` : ""].filter(Boolean).join(" · ");
}
function renderChurch() {
  unmountEditor();
  const c = A.draft, tabs = Object.entries(CTABS).filter(([k]) => c.id || !["editors", "history"].includes(k));
  if (!tabs.some(([k]) => k === A.ctab)) A.ctab = "sched";
  const meta = headerMeta();
  main.innerHTML = `<article class="ad-church" aria-labelledby="ch-name">
    <header class="ad-ch">
      <button type="button" class="ui-btn quiet ad-back" data-back>‹ Lista</button>
      <div class="ad-cht"><h1 class="ad-name" id="ch-name">${c.id ? esc(c.name) : "Új templom"}</h1><p class="ad-meta" id="ch-meta"${meta ? "" : " hidden"}>${meta}</p></div>
      <div class="ad-acts">
        <label class="ad-pub" for="f-pub"><span>Közzétéve</span><input type="checkbox" class="ui-toggle" id="f-pub" data-k="published" ${c.published ? "checked" : ""}></label>
        ${c.id ? `<a class="ui-btn secondary" href="index.html#t=${c.id}" target="_blank" rel="noopener">Megnyitás a térképen</a>` : ""}
        <button type="button" class="ui-btn primary" id="save">Mentés</button>
      </div>
    </header>
    <nav class="ad-tabs" aria-label="A templom részei">${tabs.map(([k, v]) => `<button type="button" class="ad-tab" data-ctab="${k}" aria-pressed="${A.ctab === k}">${v}</button>`).join("")}</nav>
    <div class="ad-body" id="cbody"></div>
  </article>`;
  renderCTab();
}
function renderCTab() {
  unmountEditor();
  main.querySelectorAll("[data-ctab]").forEach(b => b.setAttribute("aria-pressed", b.dataset.ctab === A.ctab));
  ({ sched: renderSched, feasts: renderFeasts, events: renderEvents, data: renderData, editors: renderEditors, history: renderHistory })[A.ctab]($("#cbody"));
}
function unmountEditor() { if (A.se) { A.se.destroy(); A.se = null; } }

/* ---------- Miserend: the shared week board, and the admin boxes beside it ---------- */
function renderSched(box) {
  const c = A.draft;
  box.innerHTML = `<div class="ad-sched">
    <section aria-label="Heti rend"><p class="ad-lead">Koppints egy időpontra a módosításhoz, a ＋ jellel új időpontot adsz a naphoz. A szabály nyers mezői (érvényesség, a hónap hetei, kéthetente, ünnepnapokon elmarad) az időpont „Haladó” részében vannak.</p><div id="board"></div></section>
    <aside class="ad-side" aria-label="Javaslatok, admin mezők, szerkesztők">${c.id ? suggBoxHTML() : ""}${adminBoxHTML()}${c.id ? editorsBoxHTML() : ""}</aside>
  </div>`;
  A.se = SE.mount($("#board"), { rules: c.services, admin: true, nearby: A.nearby, onChange: rules => { A.draft.services = rules; changed(); } });
}
function suggBoxHTML() {
  const s = A.meta?.sugg || [];
  return `<section class="ui-card ad-box" id="side-sugg"><h2>Javaslat ehhez a templomhoz · ${s.length}</h2>
    ${s.length ? s.map(x => `<div class="ad-sg"><p>„${esc(x.text)}”</p><p class="m">${esc(TYPES[x.type] || x.type)} · ${esc(x.contact || "hívő")} · ${esc(ago(x.created_at))}</p>
      <div class="ad-two"><button type="button" class="ui-btn primary" data-sugg="approved" data-id="${x.id}">Átveszem</button><button type="button" class="ui-btn secondary" data-sugg="rejected" data-id="${x.id}">Elutasítom</button></div></div>`).join("")
      : `<p class="ad-muted">Nincs döntésre váró javaslat.</p>`}
  </section>`;
}
function adminBoxHTML() {
  const c = A.draft, kv = (k, v) => `<div class="ad-kv"><span>${k}</span><span>${v}</span></div>`;
  const src = c.schedule_source, ref = c.source_ref;
  const osm = c.osm_type && c.osm_id ? `<a href="https://www.openstreetmap.org/${esc(c.osm_type)}/${esc(c.osm_id)}" target="_blank" rel="noopener">${esc(c.osm_type)}/${esc(c.osm_id)}</a>` : "";
  return `<section class="ui-card ad-box" id="side-admin"><h2>Csak admin</h2>
    <div class="ad-kv"><span>Fontosság</span><label class="ui-field" for="f-imp" title="A térkép kicsinyítve csak a legfontosabb templomokat mutatja; ezzel előrébb vagy hátrébb sorolhatod ezt a templomot."><span hidden>Kiemelés a térképen</span><select id="f-imp" data-k="importance_manual">
      <option value="" ${c.importance_manual == null || c.importance_manual === "" ? "selected" : ""}>Automatikus${c.importance_auto != null ? " (" + c.importance_auto + ")" : ""}</option>
      ${[[100, "Kiemelt – mindig látszik"], [75, "Fontos"], [50, "Átlagos"], [20, "Háttérben"]].map(([v, t]) => `<option value="${v}" ${String(c.importance_manual) === String(v) ? "selected" : ""}>${t}</option>`).join("")}
    </select></label></div>
    ${ref ? kv(src === "miserend" ? "miserend.hu" : `${esc(SOURCE_TAG[src] || src || "Forrás")} azonosító`, "#" + esc(ref)) : ""}
    ${osm ? kv("OSM", osm) : ""}
    ${src ? kv("Időpontok forrása", (c.schedule_source_url ? `<a href="${esc(c.schedule_source_url)}" target="_blank" rel="noopener">${esc(SOURCE_NAMES[src] || src)}</a>` : esc(SOURCE_NAMES[src] || src)) + (c.schedule_updated ? `, ${esc(c.schedule_updated)}` : "")) : ""}
    ${c.created_by ? kv("Létrehozta", esc(SOURCE_TAG[c.created_by] || c.created_by) + " import") : ""}
    ${c.match_confirmed ? kv("Párosítás", "megerősítve") : ""}
    <label class="ad-tg" for="f-lock"><span>Importálás zárolva<small>${src ? "Zárolva az import nem írja felül az időpontokat. Ha kézzel módosítod őket, mentéskor magától zárolódik." : "Kézzel ellenőrzött miserend – az import ne írja felül."}</small></span><input type="checkbox" class="ui-toggle" id="f-lock" data-k="schedule_locked" ${c.schedule_locked ? "checked" : ""}></label>
    <label class="ad-tg" for="f-approx"><span>Hely bizonytalan<small>A nyilvános oldalon figyelmeztetés látszik.</small></span><input type="checkbox" class="ui-toggle" id="f-approx" data-k="location_approx" ${c.location_approx ? "checked" : ""}></label>
  </section>`;
}
const REQ_STATUS = { pending: ["jóváhagyásra vár", "t-conf"], approved: ["jóváhagyva", "t-open"], rejected: ["elutasítva", "t-muted"] };
function editorsBoxHTML() {
  const eds = A.meta?.editors || [], pend = (A.meta?.requests || []).filter(r => r.status === "pending");
  const rows = [...eds.map(e => `<div class="ad-kv"><span title="${esc(e.email || "")}">${esc(e.display_name || e.email || e.user_id)}</span>${tag("t-open", "jóváhagyva")}</div>`),
    ...pend.map(r => `<div class="ad-kv"><span title="${esc(r.email || "")}">${esc(r.name)}</span>${tag("t-conf", "jóváhagyásra vár")}</div>`)];
  return `<section class="ui-card ad-box" id="side-editors"><h2>Szerkesztők</h2>
    ${rows.join("") || `<p class="ad-muted">Ehhez a templomhoz még nincs plébániai szerkesztő.</p>`}
    <a class="ui-btn quiet ad-link" href="plebania.html?templom=${A.draft.id}" target="_blank" rel="noopener">Megnyitás a plébániai felületen</a>
  </section>`;
}

/* ---------- Ünnepek ---------- */
/* 24-hour time fields: plain text so every browser shows 17:30 (never AM/PM). Accepts 1730, 17.30, 17,30, 9:5, 17. */
const timeField = (label, attrs, value) =>
  `<label class="ui-field ad-t"><span>${label}</span><input type="text" class="ad-hhmm" ${attrs} value="${esc(value)}" inputmode="numeric" maxlength="5" placeholder="ÓÓ:PP" autocomplete="off" spellcheck="false"></label>`;
// Who says it and where, if not in the church itself.
const whoWhereFields = (s, attrs) => s.kind === "mass" || s.kind === "rorate" || s.kind === "confession" || s.kind === undefined ? `
    <label class="ui-field"><span>${s.kind === "confession" ? "Ki gyóntat" : "Ki tartja"}</span><input ${attrs} data-f="celebrant" value="${esc(s.celebrant || "")}" maxlength="80" placeholder="pl. P. Kamill, plébános, püspök" autocomplete="off"></label>
    <label class="ui-field"><span>Helyszín, ha nem a templomban</span><input ${attrs} data-f="place" value="${esc(s.place || "")}" maxlength="120" placeholder="pl. temetőkápolna, kórház" autocomplete="off"></label>` : "";
const FEAST_KINDS = { mass: "Mise", confession: "Gyóntatás", adoration: "Szentségimádás" };
function renderFeasts(box) {
  const c = A.draft;
  const ALL = [...window.LitCal.FEAST_GROUPS, ...window.LitCal.FEASTS];
  const keys = ALL.map(f => f.key).filter(k => c.feasts[k]);
  const avail = ALL.filter(f => !c.feasts[f.key]);
  const now = new Date();
  const cards = keys.map(k => {
    const f = c.feasts[k], fe = window.LitCal.FEAST_BY_KEY[k], next = window.LitCal.nextFeastDate(k, now);
    return `<div class="ui-card ad-card" role="group" aria-labelledby="fh-${k}">
      <div class="ad-cardh"><div><h3 id="fh-${k}">${esc(fe.name)}</h3><span class="ad-when">${next.getFullYear()}. ${next.toLocaleDateString("hu-HU", { month: "long", day: "numeric", weekday: "long" })}</span></div>
        <button type="button" class="ui-btn danger" data-delfeast="${k}">Ünnep eltávolítása</button></div>
      <div class="ui-seg" role="group" aria-label="Rend: ${esc(fe.name)}">
        <button type="button" data-feastmode="${k}" data-v="sunday" aria-pressed="${f.mode === "sunday"}">Vasárnapi miserend szerint</button>
        <button type="button" data-feastmode="${k}" data-v="custom" aria-pressed="${f.mode === "custom"}">Egyedi időpontok</button></div>
      ${f.mode === "custom" ? `<div class="ad-rows">${f.rows.map((r, i) => `<div class="ad-line">
          <label class="ui-field"><span>Fajta</span><select data-feast="${k}" data-i="${i}" data-f="kind">${Object.entries(FEAST_KINDS).map(([kk, v]) => `<option value="${kk}" ${r.kind === kk ? "selected" : ""}>${v}</option>`).join("")}</select></label>
          ${timeField("Kezdés", `data-feast="${k}" data-i="${i}" data-f="start"`, r.start)}
          ${r.kind === "mass" ? "" : timeField("Vége", `data-feast="${k}" data-i="${i}" data-f="end"`, r.end)}
          <label class="ui-field wide"><span>Megjegyzés</span><input data-feast="${k}" data-i="${i}" data-f="note" value="${esc(r.note)}" placeholder="pl. ünnepi nagymise"></label>
          ${whoWhereFields(r, `data-feast="${k}" data-i="${i}"`)}
          <button type="button" class="ui-btn danger" data-delfeastrow="${k}" data-i="${i}" aria-label="Időpont törlése">Törlés</button></div>`).join("")}</div>
        <div class="ad-line"><button type="button" class="ui-btn secondary" data-addfeastrow="${k}">＋ Időpont</button>${k === "dec24" ? `<p class="ad-hint">Az éjféli misét 00:00-ként add meg; a térképen 24:00-ként, a nap végén látszik.</p>` : ""}</div>`
      : `<p class="ad-muted">Ezen a napon a vasárnapi rendszeres alkalmak érvényesek.</p>`}
    </div>`;
  }).join("");
  box.innerHTML = `<div class="ad-stack">
    <p class="ad-lead">Ünnepnapon az itt megadott rend lép a hétköznapi helyére. Ha egy ünnep nincs felvéve, aznap a szokásos miserend látszik. A „Parancsolt ünnepeken” és „Munkaszüneti napokon” egyszerre minden ilyen napra érvényes (ha nem vasárnapra esik); egy külön felvett ünnep ezeknél erősebb.</p>
    ${cards}
    <div class="ui-card ad-card"><div class="ad-line"><label class="ui-field wide" for="add-feast"><span>Ünnep hozzáadása</span><select id="add-feast">${avail.map(f => `<option value="${f.key}">${esc(f.name)}</option>`).join("")}</select></label>
      <button type="button" class="ui-btn secondary" id="add-feast-btn" ${avail.length ? "" : "disabled"}>Hozzáadás</button></div></div>
  </div>`;
}

/* ---------- Események ---------- */
function renderEvents(box) {
  const c = A.draft;
  box.innerHTML = `<div class="ad-stack">
    <p class="ad-lead">Egyszeri alkalmak: búcsú, bérmálás, koncert, lelkigyakorlat. A térképen a templom oldalán, a közelgő események között látszanak.</p>
    ${c.events.map((e, i) => `<div class="ui-card ad-card"><div class="ad-line">
      <label class="ui-field ad-t"><span>Dátum</span><input type="date" data-l="events" data-i="${i}" data-f="date" value="${esc(e.date)}"></label>
      ${timeField("Időpont", `data-l="events" data-i="${i}" data-f="start"`, e.start)}
      <label class="ui-field wide"><span>Cím</span><input data-l="events" data-i="${i}" data-f="title" value="${esc(e.title)}" placeholder="pl. Búcsúi szentmise"></label>
      <label class="ui-field wide"><span>Megjegyzés</span><input data-l="events" data-i="${i}" data-f="note" value="${esc(e.note)}"></label>
      <button type="button" class="ui-btn danger" data-delrow="events" data-i="${i}" aria-label="Esemény törlése">Törlés</button></div></div>`).join("") || `<p class="ad-muted">Nincs esemény.</p>`}
    <button type="button" class="ui-btn secondary ad-add" data-addrow="events">＋ Esemény</button>
  </div>`;
}

/* ---------- Adatok ---------- */
function renderData(box) {
  const c = A.draft, isAdmin = A.staff.role === "admin";
  const osm = c.lat && c.lon ? `https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lon}#map=18/${c.lat}/${c.lon}` : "";
  box.innerHTML = `<div class="ad-stack">
    <div class="ui-card ad-card"><h3>Alapadatok</h3>
      <div class="ad-grid2">
        <label class="ui-field" for="f-name"><span>Név</span><input id="f-name" data-k="name" value="${esc(c.name)}" required></label>
        <label class="ui-field" for="f-city"><span>Település</span><input id="f-city" data-k="city" value="${esc(c.city)}"></label>
        <label class="ui-field" for="f-address"><span>Cím</span><input id="f-address" data-k="address" value="${esc(c.address)}"></label>
        <label class="ui-field" for="f-rite"><span>Rítus</span><select id="f-rite" data-k="rite"><option value="rk" ${c.rite === "rk" ? "selected" : ""}>római katolikus</option><option value="gk" ${c.rite === "gk" ? "selected" : ""}>görögkatolikus</option></select></label>
        <label class="ui-field" for="f-lat"><span>Szélesség (lat)</span><input id="f-lat" data-k="lat" inputmode="decimal" value="${esc(c.lat)}"></label>
        <label class="ui-field" for="f-lon"><span>Hosszúság (lon)</span><input id="f-lon" data-k="lon" inputmode="decimal" value="${esc(c.lon)}"></label>
        <label class="ui-field" for="f-website"><span>Weboldal</span><input id="f-website" data-k="website" value="${esc(c.website)}"></label>
        <label class="ui-field" for="f-phone"><span>Telefon</span><input id="f-phone" data-k="phone" value="${esc(c.phone)}"></label>
      </div>
      ${osm ? `<a class="ui-btn secondary ad-add" href="${osm}" target="_blank" rel="noopener">Hely ellenőrzése a térképen</a>` : ""}
      <label class="ui-field" for="f-notes"><span>Belső megjegyzés (nem nyilvános)</span><textarea id="f-notes" data-k="notes" rows="3">${esc(c.notes)}</textarea></label>
    </div>
    <div class="ui-card ad-card"><div><h3>Nyitvatartás</h3><span class="ad-when">Mikor lehet bemenni imádkozni</span></div>
      <label class="ad-check" for="f-only"><input type="checkbox" class="ui-toggle" id="f-only" data-k="open_only_services" ${c.open_only_services ? "checked" : ""}><span>Csak a szertartások idején van nyitva</span></label>
      <div class="ad-rows">${c.hours.map((h, i) => `<div class="ad-hours" role="group" aria-label="Nyitvatartás, ${i + 1}. sor">
        <div class="ui-daypick" role="group" aria-label="Napok">${DAY_ORDER.map(d => `<button type="button" data-days="hours.${i}" data-d="${d}" aria-pressed="${h.days.includes(d)}" aria-label="${DAY_NAME[d]}">${DAY_SHORT[d]}</button>`).join("")}</div>
        <div class="ad-line">${timeField("Nyit", `data-l="hours" data-i="${i}" data-f="opens"`, h.opens)}${timeField("Zár", `data-l="hours" data-i="${i}" data-f="closes"`, h.closes)}
          <button type="button" class="ui-btn danger" data-delrow="hours" data-i="${i}" aria-label="Nyitvatartási sor törlése">Törlés</button></div></div>`).join("")}</div>
      <button type="button" class="ui-btn secondary ad-add" data-addrow="hours">＋ Nyitvatartási sor</button>
    </div>
    <div class="ui-card ad-card"><div><h3>Megjegyzés a miserendhez</h3><span class="ad-when">Nyilvános, a miserend alatt látszik. Webcímek kattinthatók lesznek.</span></div>
      <label class="ui-field" for="f-snote"><span hidden>Megjegyzés a miserendhez</span><textarea id="f-snote" data-k="schedule_note" rows="4" placeholder="pl. Adventben a hétköznapi misék reggel 6-kor">${esc(c.schedule_note)}</textarea></label>
    </div>
    ${c.id && isAdmin ? `<div class="ui-card ad-card"><h3>Összevonás, törlés</h3>
      <p class="ad-muted">Ha ez a templom kétszer szerepel, vond össze a másik bejegyzéssel. A törlés az időpontjait és eseményeit is törli.</p>
      <div class="ad-danger"><button type="button" class="ui-btn secondary" id="merge-open">Összevonás egy másik templommal…</button><button type="button" class="ui-btn danger" id="del">Templom törlése</button></div></div>` : ""}
  </div>`;
}

/* ---------- Szerkesztők ---------- */
function renderEditors(box) {
  const m = A.meta || noMeta(), cid = A.draft.id;
  box.innerHTML = `<div class="ad-stack">
    <p class="ad-lead">Akik ezt a templomot a plébániai felületen szerkeszthetik. A hozzáférést a plébánia kéri a plebania.html oldalon; jóváhagyás után csak ezt a templomot szerkesztheti.</p>
    ${m.editors.length ? `<ul class="ui-glist">${m.editors.map(e => `<li class="ui-row ad-row2"><span class="who"><b>${esc(e.display_name || e.email || e.user_id)}</b>${e.email ? `<small>${esc(e.email)}</small>` : ""}</span>
      <span class="ad-cacts">${tag("t-open", "jóváhagyva")}<button type="button" class="ui-btn danger" data-revoke="${esc(e.user_id)}" data-c="${cid}">Hozzáférés megvonása</button></span></li>`).join("")}</ul>`
      : `<p class="ad-muted">Ehhez a templomhoz még nincs plébániai szerkesztő.</p>`}
    <h2 class="ad-h2">Hozzáférési kérések</h2>
    ${m.requests.length ? m.requests.map(r => `<article class="ui-card ad-sgcard">
      <div class="ad-cmeta">${tag(REQ_STATUS[r.status]?.[1] || "t-muted", REQ_STATUS[r.status]?.[0] || r.status)}<span>${esc(shortWhen(r.created_at))}</span></div>
      <h3 class="ad-ctitle">${esc(r.name)}${r.position ? " – " + esc(r.position) : ""}</h3>
      <p class="ad-muted">${[r.email, r.phone].filter(Boolean).map(esc).join(" · ")}</p>
      ${r.message ? `<p>${esc(r.message)}</p>` : ""}
      ${r.status === "pending" ? `<div class="ad-cacts"><button type="button" class="ui-btn primary" data-approve="${r.id}">Jóváhagyás</button><button type="button" class="ui-btn secondary" data-reject="${r.id}">Elutasítás</button></div>` : ""}
    </article>`).join("") : `<p class="ad-muted">Ehhez a templomhoz nem érkezett kérés.</p>`}
    <a class="ui-btn secondary ad-add" href="plebania.html?templom=${cid}" target="_blank" rel="noopener">Megnyitás a plébániai felületen</a>
  </div>`;
}

/* ---------- Előzmények ---------- */
function renderHistory(box) {
  const m = A.meta || noMeta(), parish = new Set(m.editors.map(e => e.user_id));
  box.innerHTML = `<div class="ad-stack">
    <p class="ad-lead">Ki és mikor mentette ezt a templomot (az utolsó 50 mentés).</p>
    ${m.err ? `<p class="ad-msg err">${esc(m.err)}</p>` : m.edits.length ? `<ul class="ui-glist ad-hist">${m.edits.map(l => `<li class="ui-row"><span class="w">${esc(fullWhen(l.at))}</span><b>${esc(l.who || "ismeretlen")}</b>
      <span class="s">${parish.has(l.user_id) ? "Mentés a plébániai felületen" : "Mentés"}</span></li>`).join("")}</ul>`
      : `<div class="ui-empty"><strong>Még nincs mentés</strong><p>Az első mentés után itt látszik, ki és mikor módosította.</p></div>`}
  </div>`;
}

/* ---------- Editing: one set of listeners for every tab of the open church ---------- */
const isField = el => el.dataset && (el.dataset.k || el.dataset.l || el.dataset.feast);
function setVal(el) {
  const c = A.draft;
  if (el.dataset.k) c[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value;
  else if (el.dataset.l) c[el.dataset.l][+el.dataset.i][el.dataset.f] = el.value;
  else if (el.dataset.feast) c.feasts[el.dataset.feast].rows[+el.dataset.i][el.dataset.f] = el.value;
}
const inChurch = el => A.draft && A.page === "churches" && el.closest?.(".ad-church");
main.addEventListener("input", e => {
  const el = e.target;
  if (!inChurch(el) || !isField(el) || el.type === "checkbox" || el.type === "radio") return;
  setVal(el); el.closest(".ui-field")?.classList.remove("err");
  changed(el.tagName === "SELECT" ? null : el);
});
main.addEventListener("change", e => {
  const el = e.target;
  if (!inChurch(el) || !isField(el)) return;
  if (el.type === "checkbox") { setVal(el); if (el.dataset.k === "schedule_locked") A.lockTouched = true; changed(null); return; }
  if (el.dataset.feast && el.dataset.f === "kind") renderCTab();
});
// Tidy a time when leaving the field: "1730" → "17:30"; mark it if it still isn't a valid 24-hour time.
main.addEventListener("focusout", e => {
  const el = e.target; if (!el.classList?.contains("ad-hhmm") || !inChurch(el)) return;
  el.value = SE.normTime(el.value); setVal(el);
  el.closest(".ui-field")?.classList.toggle("err", !!el.value && !TIME_RE.test(el.value));
});
main.addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b || !main.contains(b)) return;
  if (b.dataset.back !== undefined) return showList();
  // The week board handles its own tiles (schedule-editor.js).
  if (!inChurch(b) || b.closest(".se-board")) return;
  const c = A.draft, d = b.dataset;
  if (d.ctab) { A.ctab = d.ctab; renderCTab(); return; }
  if (b.id === "save") return save();
  if (b.id === "del") return delChurch();
  if (b.id === "merge-open") return setTab("merge");
  if (d.sugg) return decideSuggestion(b);
  if (d.approve || d.reject || d.revoke) return churchAccessAction(b);
  if (d.days) { const [list, i] = d.days.split("."), x = +d.d, row = c[list][+i];
    row.days = row.days.includes(x) ? row.days.filter(y => y !== x) : [...row.days, x].sort((a, z) => a - z);
    b.setAttribute("aria-pressed", row.days.includes(x)); changed(); return; }
  if (d.addrow) {
    if (d.addrow === "hours") c.hours.push({ days: [1, 2, 3, 4, 5, 6, 0], opens: "08:00", closes: "18:00" });
    if (d.addrow === "events") c.events.push({ date: "", start: "", title: "", note: "" });
    changed(); return renderCTab(); }
  if (d.delrow) { c[d.delrow].splice(+d.i, 1); changed(); return renderCTab(); }
  if (b.id === "add-feast-btn") { const k = $("#add-feast").value; if (k) { c.feasts[k] = { mode: "sunday", rows: [] }; changed(); renderCTab(); } return; }
  if (d.delfeast) { delete c.feasts[d.delfeast]; changed(); return renderCTab(); }
  if (d.feastmode) { const fe = c.feasts[d.feastmode]; if (fe.mode === d.v) return;
    fe.mode = d.v; if (fe.mode === "custom" && !fe.rows.length) fe.rows.push({ kind: "mass", start: "", end: "", note: "" }); changed(); return renderCTab(); }
  if (d.addfeastrow) { c.feasts[d.addfeastrow].rows.push({ kind: "mass", start: "", end: "", note: "" }); changed(); return renderCTab(); }
  if (d.delfeastrow) { c.feasts[d.delfeastrow].rows.splice(+d.i, 1); changed(); return renderCTab(); }
});

/* ---------- Saving ---------- */
// Returns [message, tab] for the first problem, or null.
function validate(c) {
  if (!c.name.trim()) return ["Add meg a templom nevét.", "data"];
  const lat = parseFloat(String(c.lat).replace(",", ".")), lon = parseFloat(String(c.lon).replace(",", "."));
  if (!(lat >= 45 && lat <= 49) || !(lon >= 16 && lon <= 23.5)) return ["A koordináták nem Magyarország területére esnek. Ellenőrizd a szélességet és a hosszúságot.", "data"];
  const okT = (t, where) => !t || TIME_RE.test(t) ? "" : `${where}: a(z) „${t}” nem érvényes időpont. Írd 24 órás formában, pl. 17:30.`;
  for (const [i, h] of c.hours.entries()) {
    const w = `Nyitvatartás, ${i + 1}. sor`;
    if (!h.days.length) return [`${w}: jelölj ki legalább egy napot.`, "data"];
    const e = okT(h.opens, w) || okT(h.closes, w); if (e) return [e, "data"];
    if (!h.opens || !h.closes || h.opens >= h.closes) return [`${w}: a nyitás legyen a zárás előtt.`, "data"];
  }
  for (const s of c.services) {
    const w = `Miserend, ${(KINDS[s.kind] || s.kind).toLowerCase()} ${s.start || ""}`.trim();
    if (!s.days.length) return [`${w}: jelölj ki legalább egy napot.`, "sched"];
    if (!s.start) return [`${w}: add meg a kezdés idejét.`, "sched"];
    const e = okT(s.start, w) || okT(s.end, w); if (e) return [e, "sched"];
    if (s.end && s.end <= s.start) return [`${w}: a vége legyen a kezdés után.`, "sched"];
    if (+s.every > 1 && !s.anchor) return [`${w}: add meg egy nap dátumát, amikor biztosan van (ettől számoljuk a ${s.every} hetes rendet).`, "sched"];
    // Weeks count from the anchor (LitCal.everyOk): a Monday covers its whole week, any other day must be one of the days.
    const wd = +s.every > 1 ? new Date(s.anchor + "T12:00").getDay() : 1;
    if (wd !== 1 && !s.days.includes(wd)) return [`${w}: a kezdő nap (anchor) hétfő legyen, vagy a kijelölt napok egyike.`, "sched"];
  }
  for (const [k, f] of Object.entries(c.feasts)) {
    const w = window.LitCal.FEAST_BY_KEY[k].name;
    if (f.mode !== "custom") continue;
    if (!f.rows.length) return [`${w}: adj meg legalább egy időpontot, vagy válaszd a vasárnapi miserendet.`, "feasts"];
    for (const [i, r] of f.rows.entries()) {
      if (!r.start) return [`${w}, ${i + 1}. sor: add meg a kezdés idejét.`, "feasts"];
      const e = okT(r.start, w) || okT(r.end, w); if (e) return [e, "feasts"];
      if (r.end && r.end <= r.start) return [`${w}, ${i + 1}. sor: a vége legyen a kezdés után.`, "feasts"];
    }
  }
  for (const [i, e] of c.events.entries()) {
    if (!e.date || !e.title.trim()) return [`Események, ${i + 1}. sor: a dátum és a cím kötelező.`, "events"];
    const er = okT(e.start, `Események, ${i + 1}. sor`); if (er) return [er, "events"];
  }
  return null;
}
function setSaving(on) { for (const b of [$("#save"), $("#bar-save")]) if (b) { b.disabled = on; b.textContent = on ? "Mentés…" : "Mentés"; } }
async function save() {
  const c = A.draft; if (!c) return;
  const bad = validate(c);
  if (bad) { showErr(bad[0]); if (A.ctab !== bad[1]) { A.ctab = bad[1]; renderCTab(); } return; }
  setSaving(true); showErr("");
  const regular = c.services.map(s => ({ kind: s.kind, days: s.days, start: s.start, end: s.kind === "mass" || s.kind === "rorate" ? "" : (s.end || ""), note: s.note,
    period: s.kind === "rorate" ? "all" : s.period, valid: s.kind === "rorate" ? "" : (s.valid || ""), weeks: s.weeks || [],
    every: +s.every > 1 ? +s.every : null, anchor: +s.every > 1 ? s.anchor : "", tags: s.kind === "mass" || s.kind === "rorate" ? (s.tags || []) : [],
    celebrant: (s.celebrant || "").trim(), place: (s.place || "").trim(), place_church_id: s.place_church_id ? +s.place_church_id : "", feast_skip: s.kind !== "rorate" && !!s.feast_skip }));
  const feastRows = Object.entries(c.feasts).filter(([, f]) => f.mode === "custom")
    .flatMap(([k, f]) => f.rows.map(r => ({ kind: r.kind, days: [], start: r.start, end: r.kind === "mass" ? "" : (r.end || ""), note: r.note, period: "all", feast: k,
      celebrant: (r.celebrant || "").trim(), place: (r.place || "").trim() })));
  const p = { id: c.id, name: c.name.trim(), city: c.city.trim(), address: (c.address || "").trim(), rite: c.rite,
    lat: parseFloat(String(c.lat).replace(",", ".")), lon: parseFloat(String(c.lon).replace(",", ".")),
    website: c.website || "", phone: c.phone || "", notes: c.notes || "", open_only_services: !!c.open_only_services, published: !!c.published,
    feast_sunday: Object.entries(c.feasts).filter(([, f]) => f.mode === "sunday").map(([k]) => k),
    importance_manual: c.importance_manual == null || c.importance_manual === "" ? "" : Number(c.importance_manual),
    schedule_note: (c.schedule_note || "").trim(), location_approx: !!c.location_approx, schedule_locked: !!c.schedule_locked,
    hours: c.hours, services: [...regular, ...feastRows], events: c.events };
  // Times of an imported church changed by hand: lock them so the next import does not undo the edit.
  let autoLocked = false;
  if (c.schedule_source && !c.schedule_locked && !A.lockTouched && svcKey(c) !== A.svcSnapshot) { p.schedule_locked = true; c.schedule_locked = true; autoLocked = true; }
  const { data, error } = await sb.rpc("save_church", { p });
  setSaving(false);
  if (error) { showErr("Nem sikerült menteni: " + error.message); return; }
  const wasNew = !c.id;
  if (wasNew) { c.id = data; A.sel = data; }
  if (A.draft === c) {
    setDirty(false); A.svcSnapshot = svcKey(c);
    const lock = $("#f-lock"); if (lock && autoLocked) lock.checked = true;
  }
  toast("Mentve" + (autoLocked ? ". Az időpontokat kézzel módosítottad, ezért zároltuk őket az import elől." : ""));
  loadList();
  // "utoljára mentette" and, for a new church, its id, map link and the tabs that need an id.
  const meta = await loadMeta(c.id);
  if (A.draft !== c) return;
  A.meta = meta;
  if (A.page !== "churches") return;
  if (wasNew) return renderChurch();
  const m = $("#ch-meta"); if (m) { m.innerHTML = headerMeta(); m.hidden = !m.innerHTML; }
}
async function delChurch() {
  const c = A.draft;
  if (!window.confirm(`Biztosan törlöd: ${c.name}? Az időpontjai és eseményei is törlődnek. Ez nem vonható vissza.`)) return;
  const { error } = await sb.from("churches").delete().eq("id", c.id);
  if (error) { showErr("Nem sikerült törölni: " + error.message); return; }
  A.draft = null; A.sel = null; A.meta = null; setDirty(false); showList(); renderChurches();
}

/* ---------- Suggestions and access, shared by their pages and the open church ---------- */
const setSuggestion = (id, status) => sb.from("suggestions").update({ status, decided_at: new Date().toISOString(), decided_by: A.user.id }).eq("id", id);
const approveRequest = id => sb.rpc("approve_access", { req: +id });
const rejectRequest = id => sb.from("access_requests").update({ status: "rejected", decided_at: new Date().toISOString() }).eq("id", id);
const revokeEditor = (user, church) => sb.from("staff_churches").delete().eq("user_id", user).eq("church_id", church);
async function decideSuggestion(b) {
  b.disabled = true;
  const { error } = await setSuggestion(b.dataset.id, b.dataset.sugg);
  if (error) { b.disabled = false; b.textContent = "Nem sikerült, próbáld újra"; return; }
  refreshSuggCount(); loadList();
  if (A.meta) A.meta.sugg = A.meta.sugg.filter(s => String(s.id) !== b.dataset.id);
  const box = $("#side-sugg"); if (box) box.outerHTML = suggBoxHTML();
}
// Szerkesztők tab: approve / reject a request, revoke an editor (asks once more first), then reload this church's lists.
async function churchAccessAction(b) {
  const d = b.dataset, cid = A.draft.id;
  if (d.revoke && d.sure !== "1") { d.sure = "1"; b.textContent = "Biztosan megvonod?"; return; }
  b.disabled = true;
  const { error } = d.approve ? await approveRequest(d.approve) : d.reject ? await rejectRequest(d.reject) : await revokeEditor(d.revoke, d.c);
  if (error) { b.disabled = false; b.textContent = "Nem sikerült: " + error.message; return; }
  refreshSuggCount();
  const meta = await loadMeta(cid);
  if (A.draft?.id !== cid) return;
  A.meta = meta; A.parishIds.clear(); loadList();
  if (A.page === "churches" && A.ctab === "editors") renderCTab();
}
async function refreshSuggCount() {
  const [{ count }, { count: ac }, { count: cc }] = await Promise.all([
    sb.from("suggestions").select("id", { count: "exact", head: true }).eq("status", "pending"),
    sb.from("access_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
    sb.from("churches").select("id", { count: "exact", head: true })]);
  $("#sugg-count").textContent = count ? String(count) : "";
  $("#access-count").textContent = ac ? String(ac) : "";
  $("#n-churches").textContent = cc ? cc.toLocaleString("hu-HU") : "";
}
// "Templom megnyitása" on the Javaslatok and Hozzáférések pages.
function openFromPage(id) { setTab("churches", { render: false }); renderChurches(); openChurch(id); }
const SUGG_STATUS = { pending: ["Döntésre vár", "t-conf"], approved: ["Elfogadva", "t-open"], rejected: ["Elutasítva", "t-muted"] };
async function renderSuggestions() {
  main.innerHTML = `<div class="ad-page">
    <h1 class="ad-ptitle">Beküldött javaslatok</h1>
    <div class="ui-seg ad-seg" id="sst" role="group" aria-label="Állapot">${Object.entries(SUGG_STATUS).map(([k, [t]]) => `<button type="button" data-sst="${k}" aria-pressed="${A.suggStatus === k}">${t}</button>`).join("")}</div>
    <div id="slist" class="ad-cards"><p class="ad-muted">Betöltés…</p></div></div>`;
  $("#sst").addEventListener("click", e => { const b = e.target.closest("[data-sst]"); if (b && b.dataset.sst !== A.suggStatus) { A.suggStatus = b.dataset.sst; renderSuggestions(); } });
  const { data, error } = await sb.from("suggestions").select("*, churches(id,name,city)").eq("status", A.suggStatus).order("created_at", { ascending: false }).limit(100);
  if (A.page !== "sugg" || !$("#slist")) return;
  if (error) { $("#slist").innerHTML = `<p class="ad-msg err">Nem sikerült betölteni: ${esc(error.message)}</p>`; return; }
  $("#slist").innerHTML = (data || []).map(s => `<article class="ui-card ad-sgcard">
      <div class="ad-cmeta">${tag(SUGG_STATUS[s.status]?.[1] || "t-muted", SUGG_STATUS[s.status]?.[0] || s.status)}<span>${esc(TYPES[s.type] || s.type)}</span><span>${esc(shortWhen(s.created_at))}</span></div>
      <h2 class="ad-ctitle">${esc(s.churches ? s.churches.name + " (" + s.churches.city + ")" : "Ismeretlen templom")}</h2>
      <p>${esc(s.text)}</p>
      ${s.contact ? `<p class="ad-muted">Kapcsolat: ${esc(s.contact)}</p>` : ""}
      <div class="ad-cacts">
        ${s.churches ? `<button type="button" class="ui-btn secondary" data-open="${s.churches.id}">Templom megnyitása</button>` : ""}
        ${s.status === "pending" ? `<button type="button" class="ui-btn primary" data-act="approved" data-id="${s.id}">Elfogadás</button><button type="button" class="ui-btn secondary" data-act="rejected" data-id="${s.id}">Elutasítás</button>` : ""}
      </div></article>`).join("") || `<div class="ui-empty"><strong>Nincs ilyen javaslat</strong></div>`;
  $("#slist").querySelectorAll("[data-open]").forEach(b => b.addEventListener("click", () => openFromPage(+b.dataset.open)));
  $("#slist").querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", async () => {
    b.disabled = true;
    const { error } = await setSuggestion(b.dataset.id, b.dataset.act);
    if (error) { b.disabled = false; b.textContent = "Nem sikerült, próbáld újra"; return; }
    refreshSuggCount(); renderSuggestions();
  }));
}

/* ---------- Parish access: requests from plebania.html, and who edits what ---------- */
async function renderAccess() {
  main.innerHTML = `<div class="ad-page">
    <h1 class="ad-ptitle">Hozzáférési kérések</h1>
    <p class="ad-lead">A plébániák a <a href="plebania.html">plebania.html</a> oldalon hoznak létre fiókot és kérnek hozzáférést a templomukhoz. Jóváhagyás után csak azt a templomot szerkeszthetik.</p>
    <div id="alist" class="ad-cards"><p class="ad-muted">Betöltés…</p></div>
    <h2 class="ad-h2">Plébániai szerkesztők</h2><div id="elist" class="ad-cards"><p class="ad-muted">Betöltés…</p></div></div>`;
  const [{ data: reqs, error }, { data: eds }] = await Promise.all([
    sb.from("access_requests").select("*, churches(id,name,city)").order("status").order("created_at", { ascending: false }).limit(200),
    sb.from("parish_editors").select("church_id,user_id,role,display_name,email").eq("role", "parish")]);
  if (A.page !== "access" || !$("#alist")) return;
  if (error) { $("#alist").innerHTML = `<p class="ad-msg err">${/access_requests/.test(error.message) ? "Futtasd le a 010-es adatbázis-frissítést (supabase/migrations/010_parish_portal.sql)." : esc(error.message)}</p>`; return; }
  const pend = (reqs || []).filter(r => r.status === "pending"), done = (reqs || []).filter(r => r.status !== "pending").slice(0, 30);
  $("#alist").innerHTML = [...pend, ...done].map(r => `<article class="ui-card ad-sgcard">
      <div class="ad-cmeta">${tag(SUGG_STATUS[r.status]?.[1] || "t-muted", { pending: "Döntésre vár", approved: "Jóváhagyva", rejected: "Elutasítva" }[r.status] || r.status)}<span>${esc(shortWhen(r.created_at))}</span></div>
      <h2 class="ad-ctitle">${esc(r.name)}${r.position ? " – " + esc(r.position) : ""}</h2>
      <p>${esc(r.churches ? r.churches.name + (r.churches.city ? " (" + r.churches.city + ")" : "") : "#" + r.church_id)}</p>
      <p class="ad-muted">${[r.email, r.phone].filter(Boolean).map(esc).join(" · ")}</p>
      ${r.message ? `<p>${esc(r.message)}</p>` : ""}
      <div class="ad-cacts">${r.churches ? `<button type="button" class="ui-btn secondary" data-open="${r.churches.id}">Templom megnyitása</button>` : ""}
        ${r.status === "pending" ? `<button type="button" class="ui-btn primary" data-approve="${r.id}">Jóváhagyás</button><button type="button" class="ui-btn secondary" data-reject="${r.id}">Elutasítás</button>` : ""}</div></article>`).join("") || `<div class="ui-empty"><strong>Nincs kérés</strong></div>`;
  const names = new Map((await sb.from("churches").select("id,name,city").in("id", [...new Set((eds || []).map(e => e.church_id))].slice(0, 300))).data?.map(c => [c.id, c]) || []);
  if (A.page !== "access" || !$("#elist")) return;
  $("#elist").innerHTML = (eds || []).map(e => { const c = names.get(e.church_id); return `<article class="ui-card ad-sgcard"><h2 class="ad-ctitle">${esc(e.display_name || e.email || e.user_id)}</h2>
      <p>${esc(c ? c.name + (c.city ? " (" + c.city + ")" : "") : "#" + e.church_id)}${e.email ? ` <span class="ad-muted">${esc(e.email)}</span>` : ""}</p>
      <div class="ad-cacts"><button type="button" class="ui-btn secondary" data-open="${e.church_id}">Templom megnyitása</button><button type="button" class="ui-btn danger" data-revoke="${esc(e.user_id)}" data-c="${e.church_id}">Hozzáférés megvonása</button></div></article>`; }).join("") || `<p class="ad-muted">Még nincs plébániai szerkesztő.</p>`;
  main.querySelectorAll(".ad-page [data-open]").forEach(b => b.addEventListener("click", () => openFromPage(+b.dataset.open)));
  main.querySelectorAll(".ad-page [data-approve]").forEach(b => b.addEventListener("click", async () => { b.disabled = true;
    const { error } = await approveRequest(b.dataset.approve); if (error) { b.disabled = false; b.textContent = "Nem sikerült: " + error.message; return; } refreshSuggCount(); renderAccess(); }));
  main.querySelectorAll(".ad-page [data-reject]").forEach(b => b.addEventListener("click", async () => { b.disabled = true;
    const { error } = await rejectRequest(b.dataset.reject); if (error) { b.disabled = false; return; } refreshSuggCount(); renderAccess(); }));
  main.querySelectorAll(".ad-page [data-revoke]").forEach(b => b.addEventListener("click", async () => {
    if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Biztosan megvonod?"; return; }
    const { error } = await revokeEditor(b.dataset.revoke, b.dataset.c); if (error) { b.textContent = "Nem sikerült"; return; } renderAccess(); }));
}

/* ---------- Merging duplicates ---------- */
// The same church in the database twice (an import put it beside the map's church, or the map has it twice).
const mkm = (a, b) => { const R = Math.PI / 180, h = Math.sin((b.lat - a.lat) * R / 2) ** 2 + Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.sin((b.lon - a.lon) * R / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
const distText = d => d < 1 ? Math.round(d * 1000) + " m" : d.toFixed(1).replace(".", ",") + " km";
function renderMergePage() {
  ensureListCol();
  if (!A.list.length) loadList();
  renderMerge();
}
function renderMerge() {
  unmountEditor();
  const c = A.draft?.id ? A.draft : null;
  main.innerHTML = `<div class="ad-page">
    <button type="button" class="ui-btn quiet ad-back" data-back>‹ Lista</button>
    <h1 class="ad-ptitle">Összevonás</h1>
    <p class="ad-lead">Ha ugyanaz a templom kétszer szerepel (egy import a térkép temploma mellé tette, vagy a térképen kétszer van), itt vonhatod össze. Válaszd ki a listából az egyiket, utána keresd meg a párját.</p>
    ${c ? `<section class="ui-card ad-merge" id="merge" aria-label="Összevonás: ${esc(c.name)}"></section>` : `<div class="ui-empty"><strong>Válassz templomot</strong><p>A listából válaszd ki az egyik bejegyzést.</p></div>`}
  </div>`;
  if (c) openMerge();
}
async function openMerge() {
  const box = $("#merge"), c = A.draft;
  if (A.dirty) { box.innerHTML = `<p class="ad-msg err">Előbb mentsd el a módosításokat, utána vond össze.</p>`; return; }
  box.innerHTML = `<div><h2 class="ad-h2" style="margin:0">Melyik templommal azonos?</h2><p class="ad-muted">${esc(c.name)}${c.city ? ` (${esc(c.city)})` : ""} · #${c.id}</p></div>
    <label class="ad-search" for="mq">${SEARCH_ICON}<input id="mq" type="search" placeholder="Keresés névre (üresen: a legközelebbiek)" aria-label="Keresés névre" autocomplete="off"></label>
    <ul class="ad-clist" id="mlist"><li class="ad-empty">Betöltés…</li></ul><div id="mcmp"></div>`;
  const load = async () => {
    const term = fold($("#mq").value.trim()).replace(/[%,()*]/g, " ").trim();
    let q = sb.from("admin_church_list").select("id,name,city,address,lat,lon,n_services,schedule_source,location_approx,created_by,n_events,n_pending").neq("id", c.id).limit(40);
    if (term) for (const w of term.split(/\s+/)) q = q.like("search", `%${w}%`);
    else q = q.gte("lat", c.lat - 0.03).lte("lat", c.lat + 0.03).gte("lon", c.lon - 0.045).lte("lon", c.lon + 0.045);
    const { data, error } = await q;
    if (!$("#mlist")) return;
    if (error) { $("#mlist").innerHTML = `<li class="ad-empty ad-msg err">${esc(error.message)}</li>`; return; }
    const list = (data || []).map(o => ({ ...o, d: mkm(c, o) })).sort((a, b) => a.d - b.d).slice(0, 15);
    $("#mlist").innerHTML = list.map(o => `<li><button type="button" class="ad-it" data-mid="${o.id}"><span class="nm">${esc(o.name)}</span><span class="sub"><span>${esc(o.city || "–")}</span><span>${distText(o.d)}</span>${o.n_services ? tag("t-muted", o.n_services + " időpont") : tag("t-warn", "nincs időpont")}${o.location_approx ? tag("t-warn", "hely pontosítandó") : ""}${o.schedule_source ? tag("t-muted", "import") : ""}</span></button></li>`).join("") || `<li class="ad-empty">Nincs találat.</li>`;
    $("#mlist").querySelectorAll("[data-mid]").forEach(b => b.addEventListener("click", () => {
      $("#mlist").querySelectorAll("[data-mid]").forEach(x => x.setAttribute("aria-current", x === b));
      compare(list.find(o => o.id === +b.dataset.mid));
    }));
  };
  let t; $("#mq").addEventListener("input", () => { clearTimeout(t); t = setTimeout(load, 250); });
  load();
}
function compare(o) {
  const c = A.draft, me = { id: c.id, name: c.name, city: c.city, lat: +c.lat, lon: +c.lon, n_services: c.services.length + Object.values(c.feasts).reduce((n, f) => n + f.rows.length, 0), location_approx: c.location_approx, schedule_source: c.schedule_source };
  // Defaults: keep the place that is not approximate; take the times from the one that has them.
  const keepOther = me.location_approx && !o.location_approx;
  const timesFromOther = o.n_services > me.n_services;
  const opt = (name, v, label, checked) => `<label class="ad-radio"><input type="radio" name="${name}" value="${v}" ${checked ? "checked" : ""}><span>${label}</span></label>`;
  const who = x => `${esc(x.name)}${x.city ? ` (${esc(x.city)})` : ""}`;
  $("#mcmp").innerHTML = `<div class="ad-cmp">
    <p><b>${who(me)}</b> és <b>${who(o)}</b> — ${distText(mkm(me, o))} egymástól.</p>
    <fieldset class="ad-fs"><legend>Melyik helye pontos a térképen? Ez marad meg.</legend>
      ${opt("keep", "me", `Ez: ${who(me)}${me.location_approx ? " – hely pontosítandó" : ""}`, !keepOther)}${opt("keep", "other", `A másik: ${who(o)}${o.location_approx ? " – hely pontosítandó" : ""}`, keepOther)}</fieldset>
    <fieldset class="ad-fs"><legend>Melyik nevet használjuk?</legend>${opt("name", "me", esc(me.name), true)}${opt("name", "other", esc(o.name), false)}</fieldset>
    <fieldset class="ad-fs"><legend>Kinek az időpontjai maradjanak?</legend>${opt("times", "me", `${esc(me.name)} – ${me.n_services} időpont${me.schedule_source ? " (import)" : ""}`, !timesFromOther)}${opt("times", "other", `${esc(o.name)} – ${o.n_services} időpont${o.schedule_source ? " (import)" : ""}`, timesFromOther)}</fieldset>
    <p class="ad-muted">Az eseményeket, javaslatokat és plébániai szerkesztőket mindkettőtől átvesszük. A másik bejegyzés törlődik. Az import a jövőben a megmaradt templomot frissíti.</p>
    <div class="ad-cacts"><button type="button" class="ui-btn primary" id="do-merge">Összevonás</button><button type="button" class="ui-btn secondary" id="cancel-merge">Mégse</button><span class="ad-msg" id="mmsg" role="status"></span></div>
  </div>`;
  $("#cancel-merge").addEventListener("click", () => { $("#mcmp").innerHTML = ""; $("#mlist")?.querySelectorAll("[data-mid]").forEach(x => x.setAttribute("aria-current", "false")); });
  $("#do-merge").addEventListener("click", async () => {
    const pick = n => $(`#mcmp input[name="${n}"]:checked`).value;
    const keepMe = pick("keep") === "me", keepId = keepMe ? me.id : o.id, dropId = keepMe ? o.id : me.id;
    const nameFrom = (pick("name") === "me") === keepMe ? "keep" : "drop";
    const scheduleFrom = (pick("times") === "me") === keepMe ? "keep" : "drop";
    $("#do-merge").disabled = true; $("#mmsg").textContent = "Összevonás…"; $("#mmsg").className = "ad-msg";
    const { data, error } = await sb.rpc("merge_churches", { keep_id: keepId, drop_id: dropId, schedule_from: scheduleFrom, name_from: nameFrom });
    if (error) { $("#do-merge").disabled = false; $("#mmsg").textContent = "Nem sikerült: " + error.message; $("#mmsg").className = "ad-msg err"; return; }
    A.dirty = false; setTab("churches", { render: false }); await openChurch(data); loadList();
    toast("Összevonva. Ez a megmaradt templom.");
  });
}

/* ---------- Statisztika: anonymous usage counters ---------- */
// Everything comes from one call, analytics_report(days): daily counters written by the public map (analytics.js →
// track()), plus parish activity from the edit history. No visitor is ever identified.
const ST_MEASURES = { visits: "Látogatás", visitors: "Látogató", views: "Megnyitott templomoldal" };
const nf = n => Number(n || 0).toLocaleString("hu-HU");
const pct = (a, b) => b ? Math.round(a / b * 100) + "%" : "–";
function statsChart(days, m) {
  const W = 720, H = 200, L = 34, B = 22, T = 8, n = days.length, max = Math.max(1, ...days.map(d => +d[m] || 0));
  // a round top for the axis: 1, 2, 5 × 10^k
  const pow = 10 ** Math.floor(Math.log10(max)), top = [1, 2, 5, 10].map(x => x * pow).find(x => x >= max);
  const step = (W - L) / n, bw = Math.max(2, Math.min(28, step - 2)), y = v => T + (H - T - B) * (1 - v / top);
  const every = Math.ceil(n / 8);
  const day = d => new Date(d + "T12:00").toLocaleDateString("hu-HU", { month: "short", day: "numeric" });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ST_MEASURES[m])} naponta">
    ${[0, .5, 1].map(f => `<line class="grid" x1="${L}" x2="${W}" y1="${y(top * f)}" y2="${y(top * f)}"/><text x="${L - 6}" y="${y(top * f) + 4}" text-anchor="end">${nf(top * f)}</text>`).join("")}
    ${days.map((d, i) => { const v = +d[m] || 0, x = L + i * step + (step - bw) / 2, h = v ? Math.max(2, H - B - y(v)) : 0, r = Math.min(4, bw / 2, h);
      return `<g><rect class="hit" x="${L + i * step}" y="${T}" width="${step}" height="${H - T - B}" data-tip="${esc(day(d.day))}: ${nf(v)}" data-x="${(L + i * step + step / 2) / W}" data-y="${(H - B - h) / H}"/>`
        + (h ? `<path class="bar" d="M${x},${H - B}v${-(h - r)}q0,${-r} ${r},${-r}h${bw - 2 * r}q${r},0 ${r},${r}v${h - r}z"/>` : "")
        + (i % every === 0 ? `<text x="${L + i * step + step / 2}" y="${H - 6}" text-anchor="middle">${esc(day(d.day))}</text>` : "") + `</g>`; }).join("")}
  </svg><div class="st-tip" hidden></div>`;
}
const stRows = (list, name, val, open) => { const max = Math.max(1, ...list.map(val));
  return list.length ? `<div class="st-rows">${list.map(x => `<${open ? `button type="button" data-open="${x.id}"` : "div"} class="st-row" style="--w:${Math.round(val(x) / max * 100)}%"><span class="nm">${name(x)}</span><b>${nf(val(x))}</b></${open ? "button" : "div"}>`).join("")}</div>` : `<p class="st-note">Ebben az időszakban még nincs adat.</p>`; };
async function renderStats() {
  A.statDays ||= 30; A.statMeasure ||= "visits";
  main.innerHTML = `<div class="ad-page st-page">
    <div class="st-head"><h1 class="ad-ptitle">Statisztika</h1>
      <div class="ui-seg ad-seg" id="st-days" role="group" aria-label="Időszak">${[[7, "7 nap"], [30, "30 nap"], [90, "90 nap"]].map(([d, t]) => `<button type="button" data-days="${d}" aria-pressed="${A.statDays === d}">${t}</button>`).join("")}</div></div>
    <div id="st-body"><p class="ad-muted">Betöltés…</p></div></div>`;
  $("#st-days").addEventListener("click", e => { const b = e.target.closest("[data-days]"); if (b && +b.dataset.days !== A.statDays) { A.statDays = +b.dataset.days; renderStats(); } });
  const { data: r, error } = await sb.rpc("analytics_report", { p_days: A.statDays });
  if (A.page !== "stats" || !$("#st-body")) return;
  if (error) {
    $("#st-body").innerHTML = `<p class="ad-msg err">${/analytics_report/.test(error.message) || error.code === "PGRST202" ? "Futtasd le a 011-es adatbázis-frissítést (supabase/migrations/011_analytics.sql)." : "Nem sikerült betölteni: " + esc(error.message)}</p>`; return;
  }
  const t = r.totals || {}, a = r.actions || {}, sum = k => r.days.reduce((s, d) => s + (+d[k] || 0), 0);
  const visits = sum("visits"), visitors = sum("visitors"), fresh = sum("new"), cov = r.coverage || {};
  const split = (ev, labels) => { const rows = Object.entries(labels).map(([k, l]) => ({ l, n: +t[ev + ":" + k] || 0 })), tot = rows.reduce((s, x) => s + x.n, 0);
    return stRows(rows.filter(x => x.n || tot === 0).map(x => ({ ...x, l: x.l + (tot ? ` <small>${pct(x.n, tot)}</small>` : "") })), x => x.l, x => x.n); };
  const church = x => `${esc(x.name)} <small>${esc(x.city || "")}</small>`;
  const tile = (label, n, sub = "") => `<div class="ui-card st-tile"><small>${label}</small><b>${n}</b>${sub ? `<span>${sub}</span>` : ""}</div>`;
  const when = x => x ? new Date(x).toLocaleDateString("hu-HU", { year: "numeric", month: "short", day: "numeric" }) : "soha";
  $("#st-body").innerHTML = `
    <div class="st-tiles">
      ${tile("Látogatás", nf(visits), `${nf(Math.round(visits / r.days.length))} naponta`)}
      ${tile("Látogató (napi)", nf(visitors), fresh ? `ebből új: ${nf(fresh)} (${pct(fresh, visitors)})` : "")}
      ${tile("Templomoldal", nf(a.view), visits ? `${(a.view / visits || 0).toFixed(1).replace(".", ",")} látogatásonként` : "")}
      ${tile("Útvonal · hívás · web", nf((+a.dir || 0) + (+a.call || 0) + (+a.web || 0)), `mentés: ${nf(a.save)} · megosztás: ${nf(a.share)}`)}
      ${tile("Telepítés", nf(t["install:"]), `alkalmazásként: ${pct(+t["mode:app"] || 0, (+t["mode:app"] || 0) + (+t["mode:browser"] || 0))}`)}
      ${tile("Plébániai mentés", nf(r.parish_saves_count), `${nf(cov.parish_managed)} templomot kezel plébánia`)}
    </div>
    <div class="st-grid" style="margin-top:12px">
      <section class="ui-card st-box st-wide"><div class="st-head"><h2 id="st-ctitle"></h2>
          <div class="ui-seg ad-seg" id="st-m" role="group" aria-label="Mit mutasson a grafikon">${Object.entries(ST_MEASURES).map(([k, l]) => `<button type="button" data-m="${k}" aria-pressed="${A.statMeasure === k}">${l}</button>`).join("")}</div></div>
        <div class="st-chart" id="st-chart"></div>
        <details class="ui-fold"><summary>Táblázat</summary><table class="st-table"><thead><tr><th>Nap</th><th>Látogatás</th><th>Látogató</th><th>Új</th><th>Templomoldal</th></tr></thead>
          <tbody>${[...r.days].reverse().map(d => `<tr><td>${esc(d.day)}</td><td>${nf(d.visits)}</td><td>${nf(d.visitors)}</td><td>${nf(d.new)}</td><td>${nf(d.views)}</td></tr>`).join("")}</tbody></table></details>
      </section>
      <section class="ui-card st-box"><h2>Legnézettebb templomok</h2><p class="st-sub">Megnyitások; koppints a templom megnyitásához.</p>
        ${stRows(r.churches.filter(x => x.view).slice(0, 15), x => church(x) + ((+x.dir || +x.call || +x.web || +x.save) ? ` <span class="st-acts">· ${[[x.dir, "útvonal"], [x.call, "hívás"], [x.web, "web"], [x.save, "♡"]].filter(y => +y[0]).map(y => nf(y[0]) + " " + y[1]).join(" · ")}</span>` : ""), x => +x.view, true)}</section>
      <section class="ui-card st-box"><h2>Sokan nézik, de nincs időpontja</h2><p class="st-sub">Itt segít a legtöbbet egy feltöltött miserend. Összesen ${nf((cov.churches || 0) - (cov.with_times || 0))} templomnál nincs időpont (${pct((cov.churches || 0) - (cov.with_times || 0), cov.churches)}).</p>
        ${stRows(r.no_times.slice(0, 15), church, x => +x.view, true)}</section>
      <section class="ui-card st-box"><h2>Keresések</h2><p class="st-sub">Találatot adó keresőszavak (${nf(a.search)}).</p>
        ${stRows(r.searches.slice(0, 15), x => esc(x.q), x => +x.n)}</section>
      <section class="ui-card st-box"><h2>Keresések találat nélkül</h2><p class="st-sub">Hiányzó templom, település vagy más írásmód lehet (${nf(a.search_none)}).</p>
        ${stRows(r.searches_none.slice(0, 15), x => esc(x.q), x => +x.n)}</section>
      <section class="ui-card st-box"><h2>Használat</h2>
        <h3>Eszköz</h3>${split("device", { phone: "Telefon", tablet: "Táblagép", desktop: "Számítógép" })}
        <h3>Nézet</h3>${split("tab", { map: "Térkép", list: "Lista", saved: "Mentett" })}
        <h3>Szűrők</h3>${split("filter", { mass: "Mise", conf: "Gyóntatás", open: "Most nyitva", ev: "Esemény a héten", rorate: "Rorate", tag: "A mise jellege", day: "Másik nap", origin: "Másik hely" })}
        <p class="st-note">Saját helyzet használata: ${nf(t["locate:"])} · beküldött javítás: ${nf(r.suggestions?.received)} (döntésre vár: ${nf(r.suggestions?.pending)}) · betöltési hiba: ${nf((+t["error:data"] || 0) + (+t["error:map"] || 0))}</p></section>
      <section class="ui-card st-box"><h2>Plébániák</h2>
        <h3>Legutóbbi mentések</h3>${r.parish_saves.length ? `<div class="st-rows">${r.parish_saves.slice(0, 10).map(x => `<button type="button" class="st-row" data-open="${x.id}"><span class="nm">${church(x)}</span><span class="st-acts">${esc(x.who || "")} · ${esc(shortWhen(x.at))}</span></button>`).join("")}</div>` : `<p class="st-note">Még egy plébánia sem mentett.</p>`}
        <h3>Hozzáférést kapott, de még nem mentett</h3>${r.parish_never.length ? `<div class="st-rows">${r.parish_never.map(x => `<button type="button" class="st-row" data-open="${x.id}"><span class="nm">${church(x)}</span><span class="st-acts">${esc(x.who || "")}</span></button>`).join("")}</div>` : `<p class="st-note">Mindenki mentett már.</p>`}
        <h3>Fél éve nem frissített, plébánia által kezelt</h3>${r.parish_stale.length ? `<div class="st-rows">${r.parish_stale.map(x => `<button type="button" class="st-row" data-open="${x.id}"><span class="nm">${church(x)}</span><span class="st-acts">${esc(when(x.at))}</span></button>`).join("")}</div>` : `<p class="st-note">Nincs ilyen.</p>`}</section>
    </div>
    <p class="st-note" style="margin-top:12px">Névtelen számlálók: nincs süti, nincs látogatóazonosító, nincs IP-cím. A „látogató” azt jelenti, hogy egy eszköz aznap először nyitotta meg a térképet; ugyanaz az ember két eszközön kettőnek számít. Aki a böngészőjében letiltotta a követést, és az az eszköz, amelyen ez az admin oldal meg volt nyitva, nem számít bele.</p>`;
  const draw = () => {
    $("#st-ctitle").textContent = ST_MEASURES[A.statMeasure] + " naponta";
    $("#st-chart").innerHTML = statsChart(r.days, A.statMeasure);
  };
  draw();
  $("#st-m").addEventListener("click", e => { const b = e.target.closest("[data-m]"); if (!b) return; A.statMeasure = b.dataset.m; $("#st-m").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b)); draw(); });
  const chart = $("#st-chart");
  chart.addEventListener("pointermove", e => { const h = e.target.closest(".hit"), tip = chart.querySelector(".st-tip"); if (!tip) return;
    if (!h) { tip.hidden = true; return; }
    tip.textContent = h.dataset.tip; tip.hidden = false; tip.style.left = h.dataset.x * 100 + "%"; tip.style.top = `calc(${h.dataset.y * 100}% - 6px)`; });
  chart.addEventListener("pointerleave", () => { const tip = chart.querySelector(".st-tip"); if (tip) tip.hidden = true; });
  $("#st-body").addEventListener("click", async e => { const b = e.target.closest("[data-open]"); if (!b) return; setTab("churches"); await openChurch(+b.dataset.open); });
}

