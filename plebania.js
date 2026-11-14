"use strict";
/* Harangszó for parishes: one church at a time, its week as a board of days (schedule-editor.js), plain questions
   instead of settings. Permissions are enforced by the database (row level security + save_church); this page only
   shows what the signed-in parish may change. Admins can open any church here with ?templom=<id>. */

const CFG = window.HARANGSZO_CONFIG || {};
const C = window.LitCal;
const SE = window.ScheduleEditor;
const real = v => typeof v === "string" && v && !v.startsWith("__");
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const main = $("#main"), topEl = $("#top"), bar = $("#savebar");
const hm = t => t ? String(t).slice(0, 5) : "";
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAYS = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAME = ["Vasárnap", "Hétfő", "Kedd", "Szerda", "Csütörtök", "Péntek", "Szombat"];
const DAY_SHORT = ["V", "H", "K", "Sze", "Cs", "P", "Szo"];
const MON = ["jan.", "febr.", "márc.", "ápr.", "máj.", "jún.", "júl.", "aug.", "szept.", "okt.", "nov.", "dec."];
const FEAST_KIND = { mass: "Szentmise", confession: "Gyóntatás", adoration: "Szentségimádás" };
const FEAST_MODES = [["", "Szokásos rend"], ["sunday", "Vasárnapi rend"], ["custom", "Saját idők"]];
// The preview's words after the times ("08:00 · 10:00 mise · 17:30 gyónás").
const PV_WORD = { mass: "mise", rorate: "rorate", confession: "gyónás", adoration: "szentségimádás" };
const KORDER = { mass: 0, rorate: 1, confession: 2, adoration: 3, prayer: 4 };

if (!real(CFG.supabaseUrl) || !real(CFG.supabaseAnonKey) || !window.supabase) {
  main.innerHTML = `<div class="pp-narrow"><h1 class="pp-title">Az oldal még nincs beállítva</h1><p class="pp-lead">Az adatbázis elérése hiányzik. Szólj a Harangszó gazdájának.</p></div>`;
  throw new Error("not configured");
}
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
// view: which screen is shown; mode: the phone's edit / preview switch; changes: edits since the last save.
const P = { user: null, staff: null, ids: [], church: null, d: null, tab: "week", mode: "edit", view: "", dirty: false, changes: 0, savedAt: null, se: null };
let uidN = 0; const uid = () => "i" + (++uidN);
const ymd = d => C.ymd(d);
const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const dateText = d => `${MON[d.getMonth()]} ${d.getDate()}.`;

/* ---------- Header ---------- */
function whenText(t) {
  const d = new Date(t); if (isNaN(d)) return "";
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()), diff = Math.round((today() - day) / 864e5);
  if (diff === 0) return "ma " + d.toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" });
  if (diff === 1) return "tegnap";
  return (d.getFullYear() !== today().getFullYear() ? d.getFullYear() + ". " : "") + dateText(d);
}
function renderTop() {
  const c = P.view === "church" ? P.church : null, u = P.user, isAdmin = P.staff?.role === "admin";
  const who = u ? `<div class="pp-who"><span class="em">${esc(u.email || P.staff?.display_name || "")}</span>
    ${c && P.ids.length > 1 ? `<button class="ui-btn quiet" id="other" type="button">Templom váltása</button>` : ""}
    ${isAdmin ? `<a class="ui-btn quiet" href="admin.html">Adminisztrátori felület</a>` : ""}
    <button class="ui-btn quiet" id="logout" type="button">Kijelentkezés</button></div>` : "";
  topEl.className = "pp-top" + (c ? " church" : "");
  if (c) {
    const saved = [P.savedAt, c.parish_updated_at].filter(Boolean).map(t => new Date(t)).sort((a, b) => b - a)[0];
    const when = saved ? whenText(saved) : "";
    topEl.innerHTML = `<div class="pp-head"><span class="pp-kicker">Plébánia · szerkesztés</span><h1 class="pp-name">${esc(c.name)}</h1>
      <p class="pp-state">${c.published ? "Látható a térképen" : "Rejtve"}${when ? " · utoljára mentve " + esc(when) : ""}</p></div>${who}`;
  } else topEl.innerHTML = `<a class="pp-brand" href="./">Harangszó<small>plébániáknak</small></a>${who}`;
  $("#logout")?.addEventListener("click", async () => { if (P.dirty && !confirm("Vannak nem mentett változások. Biztosan kilépsz?")) return; P.dirty = false; await sb.auth.signOut(); });
  $("#other")?.addEventListener("click", async () => { const { data } = await sb.from("churches").select("id,name,city").in("id", P.ids); renderPicker(data || []); });
}
// Leaving the church editor: the week board's sheet goes, the save bar hides.
function leaveChurch(view) {
  unmountEditor();
  P.view = view;
  bar.classList.remove("on");
  renderTop();
}

/* ---------- Sign-in ---------- */
function renderAuth(mode = "login", msg = "", ok = false) {
  leaveChurch("auth");
  const titles = { login: "Belépés", signup: "Fiók létrehozása", forgot: "Új jelszó kérése", reset: "Új jelszó megadása" };
  main.innerHTML = `<form class="pp-narrow" id="auth" novalidate>
    <h1 class="pp-title">${titles[mode]}</h1>
    ${mode === "login" ? `<p class="pp-lead">Itt töltheti fel a plébánia, mikor van szentmise, gyóntatás és szentségimádás a templomban. A hívek a Harangszó térképén látják.</p>` : ""}
    ${mode === "signup" ? `<p class="pp-lead">Az első belépés után kiválasztod a templomodat, és mi jóváhagyjuk a hozzáférést.</p>
      <label class="ui-field"><span>Neved</span><input id="a-name" autocomplete="name" required></label>` : ""}
    ${mode !== "reset" ? `<label class="ui-field"><span>E-mail-cím</span><input id="a-em" type="email" autocomplete="username" required></label>` : ""}
    ${mode === "login" || mode === "signup" || mode === "reset" ? `<label class="ui-field"><span>${mode === "reset" ? "Új jelszó" : "Jelszó"}</span><input id="a-pw" type="password" autocomplete="${mode === "login" ? "current-password" : "new-password"}" minlength="8" required>${mode !== "login" ? "<small>Legalább 8 karakter.</small>" : ""}</label>` : ""}
    ${mode === "signup" ? `<p class="pp-legal">A fiók létrehozásával elfogadod a <a href="jogi.html#feltetelek" target="_blank" rel="noopener">felhasználási feltételeket</a>, és tudomásul veszed az <a href="jogi.html#adatkezeles" target="_blank" rel="noopener">adatkezelési tájékoztatót</a>.</p>` : ""}
    <button class="ui-btn primary" type="submit">${{ login: "Belépés", signup: "Fiók létrehozása", forgot: "Levél küldése", reset: "Jelszó mentése" }[mode]}</button>
    <p class="pp-msg ${ok ? "ok" : "err"}" id="a-msg" role="alert">${esc(msg)}</p>
    <div class="pp-links">
      ${mode === "login" ? `<button type="button" class="ui-btn quiet" data-mode="signup">Még nincs fiókom</button><button type="button" class="ui-btn quiet" data-mode="forgot">Elfelejtettem a jelszót</button>` : `<button type="button" class="ui-btn quiet" data-mode="login">Vissza a belépéshez</button>`}
    </div>
    <p class="pp-legal"><a href="jogi.html" target="_blank" rel="noopener">Impresszum · Adatkezelés · Feltételek</a></p>
  </form>`;
  main.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => renderAuth(b.dataset.mode)));
  $("#auth").addEventListener("submit", async e => {
    e.preventDefault();
    const m = $("#a-msg"), say = (t, good) => { m.textContent = t; m.className = "pp-msg " + (good ? "ok" : "err"); };
    const em = $("#a-em")?.value.trim(), pw = $("#a-pw")?.value || "";
    if (mode !== "reset" && !/^\S+@\S+\.\S+$/.test(em)) return say("Adj meg egy e-mail-címet.");
    if ((mode === "signup" || mode === "reset") && pw.length < 8) return say("A jelszó legalább 8 karakter legyen.");
    say("Egy pillanat…", true);
    const back = location.origin + location.pathname;
    if (mode === "login") {
      const { error } = await sb.auth.signInWithPassword({ email: em, password: pw });
      if (error) say(/invalid login/i.test(error.message) ? "Hibás e-mail-cím vagy jelszó." : /not confirmed/i.test(error.message) ? "Előbb erősítsd meg a címedet az e-mailben kapott linkkel." : "Nem sikerült belépni: " + error.message);
    } else if (mode === "signup") {
      const name = $("#a-name").value.trim(); if (name.length < 2) return say("Írd be a neved.");
      const { data, error } = await sb.auth.signUp({ email: em, password: pw, options: { data: { name }, emailRedirectTo: back } });
      if (error) return say(/registered/i.test(error.message) ? "Ezzel a címmel már van fiók. Lépj be, vagy kérj új jelszót." : "Nem sikerült: " + error.message);
      try { sessionStorage.setItem("pp-name", name); } catch (_) { }
      if (!data.session) renderAuth("login", "Küldtünk egy levelet. A benne lévő linkkel erősítsd meg a címedet, utána itt beléphetsz.", true);
    } else if (mode === "forgot") {
      const { error } = await sb.auth.resetPasswordForEmail(em, { redirectTo: back });
      say(error ? "Nem sikerült elküldeni: " + error.message : "Ha van fiók ezzel a címmel, küldtünk egy levelet az új jelszóhoz.", !error);
    } else {
      const { error } = await sb.auth.updateUser({ password: pw });
      if (error) return say("Nem sikerült: " + error.message);
      P.user = null; const { data } = await sb.auth.getUser(); if (data.user) afterLogin(data.user);
    }
  });
}
let recovering = false;
sb.auth.onAuthStateChange((ev, session) => {
  if (ev === "PASSWORD_RECOVERY") { recovering = true; return renderAuth("reset"); }
  if (recovering) return;
  if (session?.user) { if (P.user?.id !== session.user.id) afterLogin(session.user); }
  else { P.user = null; P.staff = null; renderAuth(); }
});
sb.auth.getSession().then(({ data }) => { if (!data.session) renderAuth(); });

async function afterLogin(user) {
  P.user = user;
  const { data: staff } = await sb.from("staff").select("role,display_name").eq("user_id", user.id).maybeSingle();
  P.staff = staff;
  renderTop();
  const isAdmin = staff?.role === "admin";
  const want = +new URLSearchParams(location.search).get("templom") || null;
  if (isAdmin) return want ? openChurch(want) : renderPicker([], true);
  if (staff?.role === "parish") {
    const { data } = await sb.from("staff_churches").select("church_id, churches(id,name,city)").eq("user_id", user.id);
    P.ids = (data || []).map(r => r.church_id);
    if (P.ids.length === 1) return openChurch(P.ids[0]);
    if (P.ids.length > 1) return want && P.ids.includes(want) ? openChurch(want) : renderPicker((data || []).map(r => r.churches).filter(Boolean));
  }
  renderRequest();
}

/* ---------- Choosing a church (several churches, or an admin) ---------- */
const resultRows = (list, chosen) => list.map(c => `<button type="button" class="ui-row" data-id="${c.id}"${chosen !== undefined ? ` aria-pressed="${chosen === c.id}"` : ""}><b>${esc(c.name)}</b><small>${esc(c.city || "")}</small></button>`).join("");
function renderPicker(list, admin = false) {
  leaveChurch("picker");
  main.innerHTML = `<div class="pp-narrow">
    <h1 class="pp-title">Melyik templom miserendjét szerkeszted?</h1>
    ${admin ? `<p class="pp-lead">Adminisztrátorként bármelyik templomot megnyithatod úgy, ahogy a plébániák látják.</p>
      <label class="ui-field"><span>Templom vagy település</span><input id="pk-q" type="search" autocomplete="off" placeholder="pl. Szent Anna, Eger"></label>` : ""}
    <div class="ui-glist pp-results" id="pk-list">${resultRows(list)}</div>
  </div>`;
  const bind = () => $("#pk-list").querySelectorAll("button").forEach(b => b.addEventListener("click", () => { history.replaceState(null, "", "?templom=" + b.dataset.id); openChurch(+b.dataset.id); }));
  bind();
  if (admin) { let t; $("#pk-q").addEventListener("input", e => { clearTimeout(t); t = setTimeout(async () => { $("#pk-list").innerHTML = resultRows(await searchChurches(e.target.value)); bind(); }, 250); }); $("#pk-q").focus(); }
}
async function searchChurches(q) {
  const words = q.replace(/[%,()*.:]/g, " ").trim().split(/\s+/).filter(w => w.length > 1).slice(0, 3);
  if (!words.length) return [];
  let r = sb.from("churches").select("id,name,city").limit(25);
  for (const w of words) r = r.or(`name.ilike.%${w}%,city.ilike.%${w}%`);
  const { data } = await r; return data || [];
}

/* ---------- Asking for access ---------- */
async function renderRequest() {
  leaveChurch("request");
  const { data: mine } = await sb.from("access_requests").select("id,status,created_at,church_id,churches(name,city)").order("created_at", { ascending: false });
  const name = (() => { try { return sessionStorage.getItem("pp-name"); } catch (_) { return ""; } })() || P.user.user_metadata?.name || "";
  const STATUS = { pending: ["jóváhagyásra vár", "t-ador"], approved: ["jóváhagyva – frissítsd az oldalt", "t-open"], rejected: ["elutasítva", "t-muted"] };
  let chosen = null;
  main.innerHTML = `<div class="pp-narrow">
    <h1 class="pp-title">Melyik templomot szerkesztenéd?</h1>
    <p class="pp-lead">Válaszd ki a templomot, és írd meg, ki vagy. Ha jóváhagytuk, ezen az oldalon rögtön szerkesztheted a miserendjét. Ha több templomot is gondozol (filiák), mindegyikhez kérj hozzáférést.</p>
    ${(mine || []).length ? `<section class="pp-reqs"><h2>Eddigi kéréseid</h2><div class="ui-glist">${mine.map(r => `<div class="ui-row pp-req"><span><b>${esc(r.churches?.name || "#" + r.church_id)}</b> <span class="muted">${esc(r.churches?.city || "")}</span></span><span class="ui-tag ${STATUS[r.status]?.[1] || "t-muted"}">${STATUS[r.status]?.[0] || esc(r.status)}</span></div>`).join("")}</div></section>` : ""}
    <form class="pp-form" id="rq" novalidate>
      <label class="ui-field"><span>Templom keresése</span><input id="rq-q" type="search" autocomplete="off" placeholder="A templom neve vagy a település"></label>
      <div class="ui-glist pp-results" id="rq-list"></div>
      <label class="ui-field"><span>Neved</span><input id="rq-name" value="${esc(name)}" autocomplete="name" required></label>
      <label class="ui-field"><span>Mi a szereped a plébánián?</span><input id="rq-pos" placeholder="pl. plébános, irodavezető, sekrestyés"></label>
      <label class="ui-field"><span>Telefonszám, ha visszahívnánk</span><input id="rq-phone" type="tel" autocomplete="tel"></label>
      <label class="ui-field"><span>Üzenet (nem kötelező)</span><textarea id="rq-msg" maxlength="600" rows="3"></textarea></label>
      <button class="ui-btn primary" type="submit">Hozzáférés kérése</button>
      <p class="pp-msg" id="rq-out" role="alert"></p>
    </form></div>`;
  let t;
  $("#rq-q").addEventListener("input", e => { clearTimeout(t); t = setTimeout(async () => {
    const list = await searchChurches(e.target.value);
    $("#rq-list").innerHTML = resultRows(list, chosen) || (e.target.value.trim().length > 1 ? `<p class="ui-row pp-muted">Nincs találat. Próbáld a település nevével.</p>` : "");
    $("#rq-list").querySelectorAll("button").forEach(b => b.addEventListener("click", () => { chosen = +b.dataset.id; $("#rq-list").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b)); }));
  }, 250); });
  $("#rq").addEventListener("submit", async e => {
    e.preventDefault(); const out = $("#rq-out");
    if (!chosen) { out.textContent = "Válaszd ki a templomot a listából."; out.className = "pp-msg err"; return; }
    const nm = $("#rq-name").value.trim(); if (nm.length < 2) { out.textContent = "Írd be a neved."; out.className = "pp-msg err"; return; }
    const { error } = await sb.from("access_requests").insert({ church_id: chosen, name: nm, position: $("#rq-pos").value.trim() || null, phone: $("#rq-phone").value.trim() || null, message: $("#rq-msg").value.trim() || null });
    if (error) { out.textContent = /duplicate|unique/i.test(error.message) ? "Ehhez a templomhoz már kértél hozzáférést." : "Nem sikerült elküldeni: " + error.message; out.className = "pp-msg err"; return; }
    renderRequest();
  });
}

/* ---------- Loading a church into an editable draft ---------- */
// The regular rules in the schedule editor's Rule shape (as admin.js keeps them); feast rows apart.
const ruleOf = s => ({ kind: s.kind, days: s.days || [], start: hm(s.start_time), end: hm(s.end_time), note: s.note || "", period: s.period || "all", valid: s.valid || "",
  weeks: s.weeks || [], every: s.every || 1, anchor: s.anchor || "", tags: s.tags || [], celebrant: s.celebrant || "", place: s.place || "",
  place_church_id: s.place_church_id || "", feast_skip: !!s.feast_skip });
async function openChurch(id, { quiet = false } = {}) {
  if (P.dirty && !confirm("Vannak nem mentett változások. Eldobod őket?")) return;
  if (!quiet) { leaveChurch("loading"); main.innerHTML = `<p class="pp-muted">Betöltés…</p>`; }
  const { data: c, error } = await sb.from("churches").select("*, opening_hours(*), services!services_church_id_fkey(*), events(*)").eq("id", id).single();
  if (error || !c) { leaveChurch("error"); main.innerHTML = `<div class="pp-narrow"><h1 class="pp-title">Ezt a templomot nem tudod megnyitni</h1><p class="pp-lead">Lehet, hogy még nincs hozzáférésed hozzá.</p></div>`; return; }
  P.church = c;
  c.services ||= []; c.events ||= []; c.opening_hours ||= [];
  const feastMode = {}, feastRows = {};
  for (const k of c.feast_sunday || []) feastMode[k] = "sunday";
  for (const s of c.services.filter(s => s.feast).sort((a, b) => String(a.start_time).localeCompare(b.start_time))) {
    feastMode[s.feast] = "custom"; (feastRows[s.feast] ||= []).push({ uid: uid(), kind: s.kind === "rorate" ? "mass" : s.kind, start: hm(s.start_time), end: hm(s.end_time), note: s.note || "", celebrant: s.celebrant || "", place: s.place || "" });
  }
  P.d = {
    rules: c.services.filter(s => !s.feast).sort((a, b) => (KORDER[a.kind] ?? 9) - (KORDER[b.kind] ?? 9) || (a.period || "").localeCompare(b.period || "") || String(a.start_time).localeCompare(String(b.start_time))).map(ruleOf),
    feastMode, feastRows,
    events: c.events.sort((a, b) => String(a.date).localeCompare(b.date)).map(e => ({ uid: uid(), date: e.date, start: hm(e.start_time), title: e.title, note: e.note || "" })),
    hours: c.opening_hours.map(h => ({ uid: uid(), days: h.days, opens: hm(h.opens), closes: hm(h.closes) })),
    phone: c.phone || "", website: c.website || "", address: c.address || "", schedule_note: c.schedule_note || "", open_only_services: !!c.open_only_services,
  };
  P.view = "church";
  setDirty(false);
  renderChurch();
}

/* ---------- Unsaved changes: the save bar ---------- */
function setDirty(v) {
  P.dirty = v;
  if (!v) { P.changes = 0; showErr(""); }
  bar.classList.toggle("on", v && P.view === "church");
  $("#savestate").textContent = `${P.changes} nem mentett változás`;
}
function showErr(t) { const e = $("#saveerr"); e.textContent = t; e.hidden = !t; }
// Each change counts once: a tap, a choice, or typing into one field until it loses focus.
let countedEl = null;
document.addEventListener("focusout", e => { if (e.target === countedEl) countedEl = null; });
function changed(el) {
  if (!el || el !== countedEl) { P.changes++; countedEl = el || null; }
  showErr("");
  setDirty(true); renderPreview();
}
window.addEventListener("beforeunload", e => { if (P.dirty) { e.preventDefault(); e.returnValue = ""; } });
let toastT;
function toast(text) {
  const t = $("#toast"); t.textContent = text; t.classList.add("on");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 3000);
}

/* ---------- Page ---------- */
const SECTIONS = { week: "Heti rend", feasts: "Ünnepek", events: "Események", data: "Adatok" };
function renderChurch() {
  unmountEditor();
  const c = P.church;
  const imported = c.schedule_source && !c.parish_updated_at && P.d.rules.length;
  renderTop();
  main.innerHTML = `<nav class="ui-tabbar pp-tabs" aria-label="Részek">${Object.entries(SECTIONS).map(([k, v]) => `<button type="button" class="ui-tab" data-sec="${k}" aria-pressed="${P.tab === k}">${v}</button>`).join("")}</nav>
    ${imported ? `<p class="pp-notice">Ezeket az időpontokat máshonnan (${c.schedule_source === "miserend" ? "a miserend.hu oldalról" : "az egyházmegye honlapjáról"}) vettük át. Nézd át őket, javítsd, ami nem stimmel, és mentsd el. Ezután a te adataid számítanak, és semmilyen automatikus frissítés nem írja felül őket.</p>` : ""}
    <div class="ui-seg pp-mode" id="mode" role="group" aria-label="Nézet"><button type="button" data-mode="edit" aria-pressed="${P.mode === "edit"}">Szerkesztés</button><button type="button" data-mode="preview" aria-pressed="${P.mode === "preview"}">Így látják a hívek</button></div>
    <div class="pp-cols" id="cols" data-mode="${P.mode}"><section class="pp-sec" id="sec" aria-label="${SECTIONS[P.tab]}"></section><aside class="pp-pv" id="preview" aria-label="Előnézet"></aside></div>`;
  main.querySelectorAll("[data-sec]").forEach(b => b.addEventListener("click", () => {
    P.tab = b.dataset.sec; main.querySelectorAll("[data-sec]").forEach(x => x.setAttribute("aria-pressed", x === b));
    $("#sec").setAttribute("aria-label", SECTIONS[P.tab]);
    setMode("edit"); renderSection();
  }));
  main.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));
  renderSection(); renderPreview();
}
function setMode(m) {
  P.mode = m;
  $("#cols")?.setAttribute("data-mode", m);
  main.querySelectorAll("[data-mode]").forEach(x => x.setAttribute("aria-pressed", x.dataset.mode === m));
}
function renderSection() { unmountEditor(); ({ week: renderWeek, feasts: renderFeasts, events: renderEvents, data: renderData })[P.tab](); }
function unmountEditor() { if (P.se) { P.se.destroy(); P.se = null; } }

/* ---------- Week board (schedule-editor.js) ---------- */
function renderWeek() {
  $("#sec").innerHTML = `<p class="pp-lead">Koppints egy időpontra a módosításhoz. Ami minden héten ugyanígy van, azt egyszer kell felvenni: a hozzáadásnál több napot is kijelölhetsz.</p><div id="board"></div>`;
  P.se = SE.mount($("#board"), { rules: P.d.rules, admin: false, nearby: [], onChange: rules => { P.d.rules = rules; changed(); } });
}

/* ---------- Feasts ---------- */
function renderFeasts() {
  const from = today(), d = P.d;
  const list = [...C.FEAST_GROUPS.map(g => ({ key: g.key, name: g.name, group: true, next: C.nextFeastDate(g.key, from) })),
    ...C.FEASTS.map(f => ({ key: f.key, name: f.name, next: C.nextFeastDate(f.key, from) })).sort((a, b) => a.next - b.next)];
  const groupHint = { holyday: "jan. 1., jan. 6., aug. 15., nov. 1., dec. 25., ha hétköznapra esik", public: "pl. márc. 15., nagypéntek, húsvét- és pünkösdhétfő, máj. 1., aug. 20., okt. 23., dec. 24–26." };
  const rows = k => d.feastRows[k] ||= [];
  $("#sec").innerHTML = `<p class="pp-lead">Ha egy ünnepen másképp van mise, mint egyébként azon a napon, itt add meg. Amit nem állítasz be, azon a napon a heti miserend érvényes. A két csoportos sor minden ilyen napra vonatkozik; egy külön beállított ünnep erősebb náluk.</p>
    <div class="pp-list">${list.map(x => { const m = d.feastMode[x.key] || ""; return `<div class="pp-card" role="group" aria-labelledby="fh-${x.key}"><div><h3 id="fh-${x.key}">${esc(x.name)}</h3><span class="when">${x.group ? groupHint[x.key] : `${x.next.getFullYear()}. ${dateText(x.next)}, ${DAY_NAME[x.next.getDay()].toLowerCase()}`}</span></div>
      <div class="ui-seg" role="group" aria-label="Rend: ${esc(x.name)}">${FEAST_MODES.map(([k, v]) => `<button type="button" data-fm="${x.key}" data-v="${k}" aria-pressed="${m === k}">${v}</button>`).join("")}</div>
      ${m === "custom" ? `<div class="pp-rows">${rows(x.key).map(r => `<div class="pp-line">
          <label class="ui-field"><span>Mi ez?</span><select data-fr="${x.key}" data-u="${r.uid}" data-f="kind">${Object.entries(FEAST_KIND).map(([k, v]) => `<option value="${k}" ${r.kind === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
          <label class="ui-field t"><span>Kezdés</span><input type="time" data-fr="${x.key}" data-u="${r.uid}" data-f="start" value="${esc(r.start)}"></label>
          ${r.kind !== "mass" ? `<label class="ui-field t"><span>Vége</span><input type="time" data-fr="${x.key}" data-u="${r.uid}" data-f="end" value="${esc(r.end)}"></label>` : ""}
          <label class="ui-field"><span>Ki tartja?</span><input data-fr="${x.key}" data-u="${r.uid}" data-f="celebrant" value="${esc(r.celebrant)}" maxlength="80"></label>
          <label class="ui-field wide"><span>Megjegyzés</span><input data-fr="${x.key}" data-u="${r.uid}" data-f="note" value="${esc(r.note)}" placeholder="${x.key === "dec24" ? "pl. éjféli mise (00:00-ként add meg)" : "pl. ünnepi nagymise"}"></label>
          <button type="button" class="ui-btn danger" data-frdel="${x.key}" data-u="${r.uid}" aria-label="Időpont törlése">Törlés</button></div>`).join("")}</div>
        <button type="button" class="ui-btn secondary pp-add" data-fradd="${x.key}">＋ Időpont</button>` : ""}</div>`; }).join("")}</div>`;
  const sec = $("#sec");
  sec.querySelectorAll("[data-fm]").forEach(b => b.addEventListener("click", () => { const k = b.dataset.fm, v = b.dataset.v; if ((d.feastMode[k] || "") === v) return;
    if (v) d.feastMode[k] = v; else delete d.feastMode[k];
    if (v === "custom" && !rows(k).length) rows(k).push({ uid: uid(), kind: "mass", start: "", end: "", note: "", celebrant: "", place: "" }); changed(); renderFeasts(); }));
  sec.querySelectorAll("[data-fr]").forEach(el => el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => { const r = rows(el.dataset.fr).find(r => r.uid === el.dataset.u); r[el.dataset.f] = el.value; changed(el.tagName === "SELECT" ? null : el); if (el.dataset.f === "kind") renderFeasts(); }));
  sec.querySelectorAll("[data-fradd]").forEach(b => b.addEventListener("click", () => { rows(b.dataset.fradd).push({ uid: uid(), kind: "mass", start: "", end: "", note: "", celebrant: "", place: "" }); changed(); renderFeasts(); }));
  sec.querySelectorAll("[data-frdel]").forEach(b => b.addEventListener("click", () => { const k = b.dataset.frdel; d.feastRows[k] = rows(k).filter(r => r.uid !== b.dataset.u); if (!d.feastRows[k].length) delete d.feastMode[k]; changed(); renderFeasts(); }));
}

/* ---------- Events ---------- */
function renderEvents() {
  const t = ymd(today()), d = P.d, up = d.events.filter(e => !e.date || e.date >= t), past = d.events.length - up.length;
  $("#sec").innerHTML = `<p class="pp-lead">Egyszeri alkalmak: búcsú, bérmálás, koncert, lelkigyakorlat. A térképen a templom oldalán, a közelgő események között látszanak.</p>
    <div class="pp-list">${up.map(e => `<div class="pp-card"><div class="pp-line">
      <label class="ui-field d"><span>Dátum</span><input type="date" data-ev="${e.uid}" data-f="date" value="${esc(e.date)}" min="${t}"></label>
      <label class="ui-field t"><span>Kezdés</span><input type="time" data-ev="${e.uid}" data-f="start" value="${esc(e.start)}"></label>
      <label class="ui-field wide"><span>Megnevezés</span><input data-ev="${e.uid}" data-f="title" value="${esc(e.title)}" maxlength="200" placeholder="pl. Búcsúi szentmise"></label>
      <label class="ui-field wide"><span>Megjegyzés</span><input data-ev="${e.uid}" data-f="note" value="${esc(e.note)}"></label>
      <button type="button" class="ui-btn danger" data-evdel="${e.uid}">Törlés</button></div></div>`).join("") || `<p class="pp-muted">Nincs közelgő esemény.</p>`}
      <button type="button" class="ui-btn secondary pp-add" id="ev-add">＋ Esemény</button></div>
    ${past ? `<p class="pp-muted" style="margin-top:12px">${past} korábbi esemény az archívumban marad.</p>` : ""}`;
  $("#sec").querySelectorAll("[data-ev]").forEach(el => el.addEventListener("input", () => { d.events.find(e => e.uid === el.dataset.ev)[el.dataset.f] = el.value; changed(el); }));
  $("#sec").querySelectorAll("[data-evdel]").forEach(b => b.addEventListener("click", () => { d.events = d.events.filter(e => e.uid !== b.dataset.evdel); changed(); renderEvents(); }));
  $("#ev-add").addEventListener("click", () => { d.events.push({ uid: uid(), date: "", start: "", title: "", note: "" }); changed(); renderEvents(); $("#sec").querySelectorAll("[data-f=date]")[up.length]?.focus(); });
}

/* ---------- Church details ---------- */
function renderData() {
  const d = P.d, c = P.church;
  $("#sec").innerHTML = `<div class="pp-list">
    <section class="pp-card" aria-labelledby="ph-h"><div><h3 id="ph-h">Fotó</h3><span class="when">A térképen a templom oldalának tetején látszik</span></div><div id="photo"></div></section>
    <div class="pp-card"><h3>Elérhetőség</h3><div class="pp-line">
      <label class="ui-field"><span>Telefonszám</span><input data-k="phone" type="tel" value="${esc(d.phone)}"></label>
      <label class="ui-field"><span>Weboldal</span><input data-k="website" type="url" value="${esc(d.website)}" placeholder="https://"></label>
      <label class="ui-field wide"><span>Cím</span><input data-k="address" value="${esc(d.address)}"></label></div>
      <p class="pp-muted">A templom neve (${esc(c.name)}) és helye a térképen csak nálunk módosítható. Ha hibás, írd meg a megjegyzésben vagy a térképen a „Javítás beküldése” gombbal.</p></div>
    <div class="pp-card"><div><h3>Nyitvatartás</h3><span class="when">Mikor lehet bemenni imádkozni</span></div>
      <label class="pp-check"><input type="checkbox" class="ui-toggle" data-k="open_only_services" ${d.open_only_services ? "checked" : ""}><span>Csak a szertartások idején van nyitva</span></label>
      ${d.hours.map(h => `<div class="pp-hours" role="group" aria-label="Nyitvatartás"><div class="ui-daypick" role="group" aria-label="Napok">${DAYS.map(x => `<button type="button" data-hd="${h.uid}" data-d="${x}" aria-pressed="${h.days.includes(x)}" aria-label="${DAY_NAME[x]}">${DAY_SHORT[x]}</button>`).join("")}</div>
        <div class="pp-line"><label class="ui-field t"><span>Nyit</span><input type="time" data-h="${h.uid}" data-f="opens" value="${esc(h.opens)}"></label>
        <label class="ui-field t"><span>Zár</span><input type="time" data-h="${h.uid}" data-f="closes" value="${esc(h.closes)}"></label>
        <button type="button" class="ui-btn danger" data-hdel="${h.uid}">Törlés</button></div></div>`).join("")}
      <button type="button" class="ui-btn secondary pp-add" id="h-add">＋ Nyitvatartás</button></div>
    <div class="pp-card"><div><h3>Megjegyzés a miserendhez</h3><span class="when">A hívek a miserend alatt látják</span></div>
      <label class="ui-field"><span hidden>Megjegyzés a miserendhez</span><textarea data-k="schedule_note" maxlength="1500" rows="4" placeholder="pl. Nyári szünetben a hétköznapi misék a plébániatemplomban vannak. Gyóntatás előzetes egyeztetéssel is: 06 30 …">${esc(d.schedule_note)}</textarea></label></div></div>`;
  const sec = $("#sec");
  window.ChurchPhoto.mount($("#photo"), { sb, church: c, admin: P.staff?.role === "admin", toast });
  sec.querySelectorAll("[data-k]").forEach(el => el.addEventListener(el.type === "checkbox" ? "change" : "input", () => { d[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value; changed(el.type === "checkbox" ? null : el); }));
  sec.querySelectorAll("[data-h]").forEach(el => el.addEventListener("input", () => { d.hours.find(h => h.uid === el.dataset.h)[el.dataset.f] = el.value; changed(el); }));
  sec.querySelectorAll("[data-hd]").forEach(b => b.addEventListener("click", () => { const h = d.hours.find(h => h.uid === b.dataset.hd), x = +b.dataset.d; h.days = h.days.includes(x) ? h.days.filter(y => y !== x) : [...h.days, x]; b.setAttribute("aria-pressed", h.days.includes(x)); changed(); }));
  sec.querySelectorAll("[data-hdel]").forEach(b => b.addEventListener("click", () => { d.hours = d.hours.filter(h => h.uid !== b.dataset.hdel); changed(); renderData(); }));
  $("#h-add").addEventListener("click", () => { d.hours.push({ uid: uid(), days: [1, 2, 3, 4, 5, 6, 0], opens: "08:00", closes: "18:00" }); changed(); renderData(); });
}

/* ---------- What the faithful will see: the next 7 days ---------- */
function dayList(date, items) {
  const d = P.d, feasts = C.feastsOn(date), dow = date.getDay();
  const custom = feasts.filter(k => d.feastMode[k] === "custom" && (d.feastRows[k] || []).length);
  const own = custom.filter(k => !C.isGroup(k)), use = own.length ? own : custom;
  const fname = feasts.length ? C.FEAST_BY_KEY[feasts[0]]?.name : "";
  if (use.length) return { feast: fname, rows: use.flatMap(k => d.feastRows[k]).filter(r => TIME_RE.test(r.start)) };
  const sunday = feasts.some(k => d.feastMode[k] === "sunday");
  const holiday = C.isHoliday(date), advent = C.inAdvent(date);
  const rows = items.filter(i => sunday
    ? i.day === 0 && i.kind !== "rorate" && C.inPeriod(date, i.period, i.valid) && !i.weeks.length && !(+i.every > 1)
    : i.day === dow && C.inPeriod(date, i.period, i.valid) && C.weekOk(date, i.weeks) && C.everyOk(date, +i.every > 1 ? +i.every : null, i.anchor) && (i.kind !== "rorate" || advent) && !(i.feast_skip && holiday));
  return { feast: fname ? fname + (sunday ? " · vasárnapi rend" : "") : "", rows };
}
// Times in order, each run of the same kind followed by its word: "08:00 · 10:00 mise · 17:30 gyónás".
function timesText(rows) {
  const groups = [];
  for (const r of rows) {
    const w = r.kind === "prayer" ? (r.note || "").trim() || "imaóra" : PV_WORD[r.kind] || r.kind, last = groups[groups.length - 1];
    if (last && last.w === w) last.t.push(r.start); else groups.push({ w, t: [r.start] });
  }
  return groups.map(g => g.t.join(" · ") + " " + g.w).join(" · ");
}
function renderPreview() {
  const box = $("#preview"); if (!box) return;
  const t = today(), items = SE.split(P.d.rules).filter(i => i.day !== null);
  box.innerHTML = `<h2>Így látják a hívek</h2><p class="pv-kicker">A következő 7 nap</p>${P.dirty ? `<p class="pv-note">A mostani beállítások szerint, mentés után.</p>` : ""}
    <ul class="ui-glist">${Array.from({ length: 7 }, (_, n) => C.addDays(t, n)).map(date => { const x = dayList(date, items); const rows = [...x.rows].sort((a, b) => a.start.localeCompare(b.start));
      return `<li class="ui-row pv-row"><span class="d"><b>${DAY_NAME[date.getDay()]}</b>${dateText(date)}</span><span>${rows.length ? esc(timesText(rows)) : `<span class="none">nincs</span>`}${x.feast ? `<span class="f">${esc(x.feast)}</span>` : ""}</span></li>`; }).join("")}</ul>
    <a class="ui-btn secondary pv-map" href="./#t=${P.church.id}" target="_blank" rel="noopener">Megnézem a térképen</a>`;
}

/* ---------- Saving ---------- */
function payload() {
  const c = P.church, d = P.d;
  // Rules with equal fields merge into one (the editor's join); a rule without days is left out, as before.
  const services = SE.join(SE.split(d.rules)).filter(g => g.days.length).map(g => ({ kind: g.kind, days: g.days, start: g.start, end: g.end || "", note: g.note, period: g.period, valid: g.valid,
    weeks: g.weeks, every: +g.every > 1 ? +g.every : null, anchor: +g.every > 1 ? g.anchor : "", tags: g.tags, celebrant: g.celebrant, place: g.place, place_church_id: g.place_church_id || "", feast_skip: g.feast_skip }));
  for (const [k, m] of Object.entries(d.feastMode)) if (m === "custom") for (const r of d.feastRows[k] || []) if (TIME_RE.test(r.start))
    services.push({ kind: r.kind, days: [], start: r.start, end: r.kind === "mass" ? "" : r.end, note: r.note.trim(), period: "all", feast: k, celebrant: r.celebrant.trim(), place: r.place || "" });
  return { id: c.id, name: c.name, city: c.city, address: d.address.trim(), rite: c.rite, lat: c.lat, lon: c.lon, website: d.website.trim(), phone: d.phone.trim(), notes: c.notes || "",
    open_only_services: d.open_only_services, published: c.published, feast_sunday: Object.entries(d.feastMode).filter(([, m]) => m === "sunday").map(([k]) => k),
    importance_manual: c.importance_manual ?? "", schedule_note: d.schedule_note.trim(), location_approx: c.location_approx, schedule_locked: true,
    hours: d.hours.filter(h => h.days.length && TIME_RE.test(h.opens) && TIME_RE.test(h.closes)).map(h => ({ days: h.days, opens: h.opens, closes: h.closes })),
    services, events: d.events.filter(e => e.date && e.title.trim()).map(e => ({ date: e.date, start: e.start, title: e.title.trim(), note: e.note.trim() })) };
}
function problems() {
  const d = P.d;
  for (const [k, m] of Object.entries(d.feastMode)) if (m === "custom") for (const r of d.feastRows[k] || []) {
    if (!TIME_RE.test(r.start)) return [`${C.FEAST_BY_KEY[k].name}: add meg az időpontot, vagy töröld a sort.`, "feasts"];
    if (r.kind !== "mass" && r.end && r.end <= r.start) return [`${C.FEAST_BY_KEY[k].name}: a vége legyen később, mint a kezdés.`, "feasts"];
  }
  for (const e of d.events) if ((e.date || e.title.trim()) && (!e.date || !e.title.trim())) return ["Eseménynél add meg a dátumot és a megnevezést is.", "events"];
  for (const h of d.hours) if (!h.days.length || !TIME_RE.test(h.opens) || !TIME_RE.test(h.closes) || h.closes <= h.opens) return ["Nyitvatartás: jelöld ki a napokat, és adj meg nyitást és zárást.", "data"];
  return null;
}
$("#save").addEventListener("click", async () => {
  const btn = $("#save"), pr = problems();
  if (pr) { showErr(pr[0]); if (P.tab !== pr[1] || P.mode !== "edit") { P.tab = pr[1]; P.mode = "edit"; renderChurch(); } return; }
  btn.disabled = true; btn.textContent = "Mentés…"; showErr("");
  const { error } = await sb.rpc("save_church", { p: payload() });
  btn.disabled = false; btn.textContent = "Mentés";
  if (error) return showErr("Nem sikerült menteni: " + error.message);
  P.savedAt = new Date();
  const published = P.church.published;
  P.dirty = false; await openChurch(P.church.id, { quiet: true });
  toast(published ? "Elmentve · már látszik a térképen" : "Elmentve");
});
// Phones: show the preview; laptops: it is already beside the editor, bring it into view.
$("#pv-go").addEventListener("click", () => {
  if (matchMedia("(max-width: 979.98px)").matches) { setMode("preview"); window.scrollTo({ top: 0 }); }
  else $("#preview")?.scrollIntoView({ block: "nearest" });
});
