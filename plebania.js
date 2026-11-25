"use strict";
/* Harangszó for parishes: one church at a time, its week as a board of days (schedule-editor.js), plain questions
   instead of settings. Permissions are enforced by the database (row level security + save_church); this page only
   shows what the signed-in parish may change. Admins can open any church here with ?templom=<id>.
   The navy header carries the screen's title (or the church), on phones the edit / preview switch, and the section
   tabs (a bottom tab bar on phones). Unsaved changes are held in amber: the changed card (data-chg), the changed time
   on the week board, an amber dot on the section's tab and the amber save bar; a save lets the amber fade out. */

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
const SECTIONS = { week: "Heti rend", feasts: "Ünnepek", events: "Események", data: "Adatok" };
// The preview's words after the times ("08:00 · 10:00 mise · 17:30 gyónás").
const PV_WORD = { mass: "mise", rorate: "rorate", confession: "gyónás", adoration: "szentségimádás" };
const KORDER = { mass: 0, rorate: 1, confession: 2, adoration: 3, prayer: 4 };

const BRAND = `<a class="pp-brand" href="./">Harangszó<span>plébániáknak</span></a>`;
if (!real(CFG.supabaseUrl) || !real(CFG.supabaseAnonKey) || !window.supabase) {
  topEl.innerHTML = `<div class="pp-in"><div class="pp-bar">${BRAND}</div><h1 class="pp-title">Az oldal még nincs beállítva</h1></div>`;
  main.innerHTML = `<div class="pp-narrow"><p class="pp-lead">Az adatbázis elérése hiányzik. Szólj a Harangszó gazdájának.</p></div>`;
  throw new Error("not configured");
}
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
// view: which screen is shown; title: its heading in the header; mode: the phone's edit / preview switch;
// changes: edits since the last save; base: the church as last saved (what the amber marks compare against).
const P = { user: null, staff: null, ids: [], church: null, d: null, base: null, tab: "week", mode: "edit", view: "", title: "", dirty: false, changes: 0, savedAt: null, se: null };
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
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
// Line icons for the section tabs (the map's tab bar style): the week as a timetable, feasts, events, details.
const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const SECTION_ICON = {
  week: svg(`<path d="M4 6h16M4 12h16M4 18h10"/>`),
  feasts: svg(`<path d="m12 3.5 2.5 5.3 5.8.7-4.3 4 1.1 5.7L12 16.4l-5.1 2.8 1.1-5.7-4.3-4 5.8-.7z"/>`),
  events: svg(`<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M12.5 14.5h3.5v3h-3.5z"/>`),
  data: svg(`<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.4"/>`),
};
function renderTop() {
  const c = P.view === "church" ? P.church : null, u = P.user, isAdmin = P.staff?.role === "admin";
  const who = u ? `<div class="pp-who"><span class="em">${esc(u.email || P.staff?.display_name || "")}</span>
    ${c && P.ids.length > 1 ? `<button class="bbtn" id="other" type="button">Templom váltása</button>` : ""}
    ${isAdmin ? `<a class="bbtn" href="admin.html">Adminisztráció</a>` : ""}
    <button class="bbtn" id="logout" type="button">Kijelentkezés</button></div>` : "";
  topEl.className = "pp-top" + (c ? " church" : "");
  if (c) {
    const saved = [P.savedAt, c.parish_updated_at].filter(Boolean).map(t => new Date(t)).sort((a, b) => b - a)[0];
    const when = saved ? whenText(saved) : "";
    topEl.innerHTML = `<div class="pp-in"><div class="pp-bar">${BRAND}${who}</div>
      <h1 class="pp-name">${esc(c.name)}</h1>
      <p class="pp-state">${c.published ? "Látható a térképen" : "Rejtve"}${when ? " · utoljára mentve " + esc(when) : ""}</p>
      <div class="ui-seg pp-mode" id="mode" role="group" aria-label="Nézet"><button type="button" data-mode="edit" aria-pressed="${P.mode === "edit"}">Szerkesztés</button><button type="button" data-mode="preview" aria-pressed="${P.mode === "preview"}">Így látják a hívek</button></div>
      <nav class="ui-tabbar pp-tabs" aria-label="Részek">${Object.entries(SECTIONS).map(([k, v]) => `<button type="button" class="ui-tab" data-sec="${k}" aria-pressed="${P.tab === k}">${SECTION_ICON[k]}<span>${v}</span></button>`).join("")}</nav>
      <span class="sr" id="pp-chg" hidden>nem mentett változás van benne</span></div>`;
    topEl.querySelectorAll("[data-sec]").forEach(b => b.addEventListener("click", () => {
      P.tab = b.dataset.sec; topEl.querySelectorAll("[data-sec]").forEach(x => x.setAttribute("aria-pressed", x === b));
      $("#sec")?.setAttribute("aria-label", SECTIONS[P.tab]);
      setMode("edit"); renderSection();
    }));
    topEl.querySelectorAll("#mode [data-mode]").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));
    marks();
  } else topEl.innerHTML = `<div class="pp-in"><div class="pp-bar">${BRAND}${who}</div>${P.title ? `<h1 class="pp-title">${esc(P.title)}</h1>` : ""}</div>`;
  $("#logout")?.addEventListener("click", async () => { if (P.dirty && !confirm("Vannak nem mentett változások. Biztosan kilépsz?")) return; P.dirty = false; await sb.auth.signOut(); });
  $("#other")?.addEventListener("click", async () => { const { data } = await sb.from("churches").select("id,name,city").in("id", P.ids); renderPicker(data || []); });
}
// Leaving the church editor: the week board's sheet goes, the save bar hides; the header shows the new screen's title.
function leaveChurch(view, title = "") {
  unmountEditor();
  P.view = view; P.title = title;
  bar.classList.remove("on");
  renderTop();
}

/* ---------- Sign-in ---------- */
function renderAuth(mode = "login", msg = "", ok = false) {
  const titles = { login: "Belépés", signup: "Fiók létrehozása", forgot: "Új jelszó kérése", reset: "Új jelszó megadása" };
  leaveChurch("auth", titles[mode]);
  main.innerHTML = `<form class="pp-narrow" id="auth" novalidate aria-label="${titles[mode]}">
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
// Board-style rows: the church's name, its town in grey; the chosen one (request form) sunken with a drawn check.
const CHECK = `<svg class="ck" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`;
const resultRows = (list, chosen) => list.map(c => `<button type="button" class="ui-row" data-id="${+c.id}"${chosen !== undefined ? ` aria-pressed="${chosen === c.id}"` : ""}><b>${esc(c.name)}</b><small>${esc(c.city || "")}</small>${chosen !== undefined ? CHECK : ""}</button>`).join("");
function renderPicker(list, admin = false) {
  leaveChurch("picker", "Melyik templom miserendjét szerkeszted?");
  main.innerHTML = `<div class="pp-narrow">
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
  leaveChurch("request", "Melyik templomot szerkesztenéd?");
  const { data: mine } = await sb.from("access_requests").select("id,status,created_at,church_id,churches(name,city)").order("created_at", { ascending: false });
  const name = (() => { try { return sessionStorage.getItem("pp-name"); } catch (_) { return ""; } })() || P.user.user_metadata?.name || "";
  const STATUS = { pending: ["jóváhagyásra vár", ""], approved: ["jóváhagyva – frissítsd az oldalt", "on"], rejected: ["elutasítva", ""] };
  let chosen = null;
  main.innerHTML = `<div class="pp-narrow">
    <p class="pp-lead">Válaszd ki a templomot, és írd meg, ki vagy. Ha jóváhagytuk, ezen az oldalon rögtön szerkesztheted a miserendjét. Ha több templomot is gondozol (filiák), mindegyikhez kérj hozzáférést.</p>
    ${(mine || []).length ? `<section class="pp-reqs" aria-labelledby="rq-h"><h2 id="rq-h">Eddigi kéréseid</h2><div class="ui-glist">${mine.map(r => `<div class="ui-row pp-req"><b>${esc(r.churches?.name || "#" + r.church_id)}</b><span class="ui-meta">${r.churches?.city ? `<span>${esc(r.churches.city)}</span>` : ""}<span class="${STATUS[r.status]?.[1] || ""}">${STATUS[r.status]?.[0] || esc(r.status)}</span></span></div>`).join("")}</div></section>` : ""}
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
  if (error || !c) { leaveChurch("error", "Ezt a templomot nem tudod megnyitni"); main.innerHTML = `<div class="pp-narrow"><p class="pp-lead">Lehet, hogy még nincs hozzáférésed hozzá.</p></div>`; return; }
  P.church = c;
  c.services ||= []; c.events ||= []; c.opening_hours ||= [];
  const feastMode = {}, feastRows = {};
  for (const k of c.feast_sunday || []) feastMode[k] = "sunday";
  for (const s of c.services.filter(s => s.feast).sort((a, b) => String(a.start_time).localeCompare(b.start_time))) {
    feastMode[s.feast] = "custom"; (feastRows[s.feast] ||= []).push({ uid: uid(), kind: s.kind === "rorate" ? "mass" : s.kind, start: hm(s.start_time), end: hm(s.end_time), note: s.note || "", celebrant: s.celebrant || "", place: s.place || "" });
  }
  // The church's own feasts (its búcsú…) use the same modes; one with neither times nor the Sunday order shows the Sunday order.
  const own = (c.own_feasts || []).map(f => ({ key: f.key, name: f.name, md: f.md }));
  for (const k of Object.keys(feastMode)) if (C.isOwnKey(k) && !own.some(f => f.key === k)) { delete feastMode[k]; delete feastRows[k]; }
  for (const f of own) feastMode[f.key] ||= "sunday";
  P.d = {
    rules: c.services.filter(s => !s.feast).sort((a, b) => (KORDER[a.kind] ?? 9) - (KORDER[b.kind] ?? 9) || (a.period || "").localeCompare(b.period || "") || String(a.start_time).localeCompare(String(b.start_time))).map(ruleOf),
    feastMode, feastRows, own,
    events: c.events.sort((a, b) => String(a.date).localeCompare(b.date)).map(e => ({ uid: uid(), date: e.date, start: hm(e.start_time), title: e.title, note: e.note || "" })),
    hours: c.opening_hours.map(h => ({ uid: uid(), days: h.days, opens: hm(h.opens), closes: hm(h.closes) })),
    phone: c.phone || "", website: c.website || "", address: c.address || "", schedule_note: c.schedule_note || "", open_only_services: !!c.open_only_services,
  };
  P.base = snapshot(P.d);
  P.view = "church"; P.title = "";
  setDirty(false);
  renderChurch();
}

/* ---------- Unsaved changes: what differs from the church as last saved ---------- */
// Each part of the draft as a comparable string; a card (data-chg) or a section differs when its string does.
const weekSig = d => JSON.stringify(SE.join(SE.split(d.rules)));
const feastSig = (d, k) => JSON.stringify([d.feastMode[k] || "", d.feastMode[k] === "custom" ? (d.feastRows[k] || []).map(({ uid: _, ...r }) => r) : [], d.own.find(f => f.key === k) || null]);
const feastKeys = d => [...Object.keys(d.feastMode), ...d.own.map(f => f.key)];
const eventSig = e => JSON.stringify([e.date, e.start, e.title, e.note]);
const PART = {
  contact: d => JSON.stringify([d.phone, d.website, d.address]),
  hours: d => JSON.stringify([d.open_only_services, d.hours.map(h => [[...h.days].sort(), h.opens, h.closes])]),
  note: d => d.schedule_note,
};
function snapshot(d) {
  return {
    rules: JSON.parse(JSON.stringify(d.rules)), week: weekSig(d),
    feasts: Object.fromEntries(feastKeys(d).map(k => [k, feastSig(d, k)])),
    events: Object.fromEntries(d.events.map(e => [e.uid, eventSig(e)])), allEvents: JSON.stringify(d.events.map(eventSig)),
    parts: Object.fromEntries(Object.entries(PART).map(([k, f]) => [k, f(d)])),
  };
}
const NO_FEAST = JSON.stringify(["", [], null]);
function chgOf(key) {
  const d = P.d, b = P.base, [kind, id] = key.split(":");
  if (kind === "f") return feastSig(d, id) !== (b.feasts[id] ?? NO_FEAST);
  if (kind === "e") { const e = d.events.find(x => x.uid === id); return !!e && b.events[id] !== eventSig(e); }
  return PART[key] ? PART[key](d) !== b.parts[key] : false;
}
function sectionsChanged() {
  const d = P.d, b = P.base;
  return {
    week: weekSig(d) !== b.week,
    feasts: [...new Set([...feastKeys(d), ...Object.keys(b.feasts)])].some(k => chgOf("f:" + k)),
    events: JSON.stringify(d.events.map(eventSig)) !== b.allEvents,
    data: Object.keys(PART).some(chgOf),
  };
}
// Paints the amber: changed cards, the tabs of changed sections. When nothing differs any more (a change undone),
// the save bar goes as well.
function marks() {
  if (P.view !== "church" || !P.d || !P.base) return;
  main.querySelectorAll("[data-chg]").forEach(el => el.classList.toggle("chg", chgOf(el.dataset.chg)));
  const s = sectionsChanged();
  topEl.querySelectorAll("[data-sec]").forEach(t => {
    const on = !!s[t.dataset.sec];
    t.classList.toggle("chg", on);
    if (on) t.setAttribute("aria-describedby", "pp-chg"); else t.removeAttribute("aria-describedby");
  });
  if (P.dirty && !Object.values(s).some(Boolean)) setDirty(false);
}

/* ---------- Unsaved changes: the save bar ---------- */
function setDirty(v) {
  P.dirty = v;
  if (!v) { P.changes = 0; countedEl = null; showErr(""); }
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
  setDirty(true); renderPreview(); marks();
}
window.addEventListener("beforeunload", e => { if (P.dirty) { e.preventDefault(); e.returnValue = ""; } });
let toastT;
function toast(text) {
  const t = $("#toast"); t.textContent = text; t.classList.add("on");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 3000);
}

/* ---------- Page ---------- */
function renderChurch() {
  unmountEditor();
  const c = P.church;
  const imported = c.schedule_source && !c.parish_updated_at && P.d.rules.length;
  main.innerHTML = `${imported ? `<p class="pp-notice">Ezeket az időpontokat máshonnan (${c.schedule_source === "miserend" ? "a miserend.hu oldalról" : "az egyházmegye honlapjáról"}) vettük át. Nézd át őket, javítsd, ami nem stimmel, és mentsd el. Ezután a te adataid számítanak, és semmilyen automatikus frissítés nem írja felül őket.</p>` : ""}
    <div class="pp-cols" id="cols" data-mode="${P.mode}"><section class="pp-sec" id="sec" aria-label="${SECTIONS[P.tab]}"></section><aside class="pp-pv" id="preview" aria-label="Előnézet"></aside></div>`;
  renderTop();
  renderSection(); renderPreview();
}
function setMode(m) {
  P.mode = m;
  $("#cols")?.setAttribute("data-mode", m);
  topEl.querySelectorAll("#mode [data-mode]").forEach(x => x.setAttribute("aria-pressed", x.dataset.mode === m));
}
function renderSection() { unmountEditor(); ({ week: renderWeek, feasts: renderFeasts, events: renderEvents, data: renderData })[P.tab](); marks(); }
function unmountEditor() { if (P.se) { P.se.destroy(); P.se = null; } }

/* ---------- Week board (schedule-editor.js) ---------- */
function renderWeek() {
  $("#sec").innerHTML = `<p class="pp-lead">Koppints egy időpontra a módosításhoz. Ami minden héten ugyanígy van, azt egyszer kell felvenni: a hozzáadásnál több napot is kijelölhetsz.</p><div id="board"></div>`;
  P.se = SE.mount($("#board"), { rules: P.d.rules, baseline: P.base.rules, admin: false, nearby: [], onChange: rules => { P.d.rules = rules; changed(); } });
}

/* ---------- Feasts ---------- */
// The church's own feasts: a name and a day of the year (02-29 is held in leap years only).
const dayOptions = (m, d) => Array.from({ length: C.MONTH_DAYS[m - 1] }, (_, i) => `<option value="${i + 1}" ${i + 1 === Math.min(d, C.MONTH_DAYS[m - 1]) ? "selected" : ""}>${i + 1}.</option>`).join("");
const mdFields = (attrs, md) => { const [m, d] = md.split("-").map(Number); return `<label class="ui-field"><span>Hónap</span><select ${attrs} data-f="m">${C.MONTHS.map((n, i) => `<option value="${i + 1}" ${i + 1 === m ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <label class="ui-field t"><span>Nap</span><select ${attrs} data-f="d">${dayOptions(m, d)}</select></label>`; };
const mdFrom = (m, d) => String(m).padStart(2, "0") + "-" + String(Math.min(d, C.MONTH_DAYS[m - 1])).padStart(2, "0");
const feastName = k => (C.FEAST_BY_KEY[k] || P.d.own.find(f => f.key === k) || { name: "" }).name.trim() || "Saját ünnep";
function renderFeasts() {
  const from = today(), d = P.d;
  const list = [...C.FEAST_GROUPS.map(g => ({ key: g.key, name: g.name, group: true, next: C.nextFeastDate(g.key, from) })),
    ...C.FEASTS.map(f => ({ key: f.key, name: f.name, next: C.nextFeastDate(f.key, from) })).sort((a, b) => a.next - b.next)];
  const own = d.own.map(f => ({ key: f.key, name: f.name.trim() || "Saját ünnep", own: f, next: C.nextOwnFeastDate(f.md, from) })), full = own.length >= C.OWN_FEASTS_MAX;
  const groupHint = { holyday: "jan. 1., jan. 6., aug. 15., nov. 1., dec. 25., ha hétköznapra esik", public: "pl. márc. 15., nagypéntek, húsvét- és pünkösdhétfő, máj. 1., aug. 20., okt. 23., dec. 24–26." };
  const rows = k => d.feastRows[k] ||= [];
  const addOwn = `<div class="pp-card" role="group" aria-labelledby="of-h"><div><h3 id="of-h">Saját ünnep hozzáadása</h3><span class="when">${full ? `Legfeljebb ${C.OWN_FEASTS_MAX} saját ünnepet vehetsz fel.` : "Például a templom búcsúja vagy védőszentjének ünnepe. Minden évben ugyanazon a napon."}</span></div>
      <div class="pp-line"><label class="ui-field wide"><span>Megnevezés</span><input id="of-name" maxlength="80" placeholder="pl. Szent Anna búcsú" autocomplete="off"></label>
      ${mdFields("data-ofnew", "01-01")}</div>
      <button type="button" class="ui-btn secondary pp-add" id="of-add" ${full ? "disabled" : ""}>＋ Saját ünnep</button></div>`;
  const card = x => { const m = d.feastMode[x.key] || ""; return `<div class="pp-card" data-chg="f:${x.key}" role="group" aria-labelledby="fh-${x.key}"><div><h3 id="fh-${x.key}">${esc(x.name)}</h3><span class="when">${x.group ? groupHint[x.key] : `${x.next.getFullYear()}. ${dateText(x.next)}, ${DAY_NAME[x.next.getDay()].toLowerCase()}${x.own && x.own.md === "02-29" ? " · csak szökőévben" : ""}`}</span></div>
      ${x.own ? `<div class="pp-line"><label class="ui-field wide"><span>Megnevezés</span><input data-of="${x.key}" data-f="name" value="${esc(x.own.name)}" maxlength="80" placeholder="pl. Szent Anna búcsú" autocomplete="off"></label>
      ${mdFields(`data-of="${x.key}"`, x.own.md)}</div>` : ""}
      <div class="ui-seg" role="group" aria-label="Rend: ${esc(x.name)}">${FEAST_MODES.filter(([k]) => k || !x.own).map(([k, v]) => `<button type="button" data-fm="${x.key}" data-v="${k}" aria-pressed="${m === k}">${v}</button>`).join("")}</div>
      ${m === "custom" ? `<div class="pp-rows">${rows(x.key).map(r => `<div class="pp-line">
          <label class="ui-field"><span>Mi ez?</span><select data-fr="${x.key}" data-u="${r.uid}" data-f="kind">${Object.entries(FEAST_KIND).map(([k, v]) => `<option value="${k}" ${r.kind === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
          <label class="ui-field t"><span>Kezdés</span><input type="time" data-fr="${x.key}" data-u="${r.uid}" data-f="start" value="${esc(r.start)}"></label>
          ${r.kind !== "mass" ? `<label class="ui-field t"><span>Vége</span><input type="time" data-fr="${x.key}" data-u="${r.uid}" data-f="end" value="${esc(r.end)}"></label>` : ""}
          <label class="ui-field"><span>Ki tartja?</span><input data-fr="${x.key}" data-u="${r.uid}" data-f="celebrant" value="${esc(r.celebrant)}" maxlength="80"></label>
          <label class="ui-field wide"><span>Megjegyzés</span><input data-fr="${x.key}" data-u="${r.uid}" data-f="note" value="${esc(r.note)}" placeholder="${x.key === "dec24" ? "pl. éjféli mise (00:00-ként add meg)" : "pl. ünnepi nagymise"}"></label>
          <button type="button" class="ui-btn danger" data-frdel="${x.key}" data-u="${r.uid}" aria-label="Időpont törlése">Törlés</button></div>`).join("")}</div>
        <button type="button" class="ui-btn secondary pp-add" data-fradd="${x.key}">＋ Időpont</button>` : ""}
      ${x.own ? `<button type="button" class="ui-btn danger pp-add" data-ofdel="${x.key}">Ünnep eltávolítása</button>` : ""}</div>`; };
  $("#sec").innerHTML = `<p class="pp-lead">Ha egy ünnepen másképp van mise, mint egyébként azon a napon, itt add meg. Amit nem állítasz be, azon a napon a heti miserend érvényes. A két csoportos sor minden ilyen napra vonatkozik; egy külön beállított ünnep erősebb náluk.</p>
    <div class="pp-list">${own.map(card).join("")}${addOwn}${list.map(card).join("")}</div>`;
  const sec = $("#sec");
  sec.querySelectorAll("[data-fm]").forEach(b => b.addEventListener("click", () => { const k = b.dataset.fm, v = b.dataset.v; if ((d.feastMode[k] || "") === v) return;
    if (v) d.feastMode[k] = v; else delete d.feastMode[k];
    if (v === "custom" && !rows(k).length) rows(k).push({ uid: uid(), kind: "mass", start: "", end: "", note: "", celebrant: "", place: "" }); changed(); renderFeasts(); }));
  sec.querySelectorAll("[data-fr]").forEach(el => el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => { const r = rows(el.dataset.fr).find(r => r.uid === el.dataset.u); r[el.dataset.f] = el.value; changed(el.tagName === "SELECT" ? null : el); if (el.dataset.f === "kind") renderFeasts(); }));
  sec.querySelectorAll("[data-fradd]").forEach(b => b.addEventListener("click", () => { rows(b.dataset.fradd).push({ uid: uid(), kind: "mass", start: "", end: "", note: "", celebrant: "", place: "" }); changed(); renderFeasts(); }));
  sec.querySelectorAll("[data-frdel]").forEach(b => b.addEventListener("click", () => { const k = b.dataset.frdel; d.feastRows[k] = rows(k).filter(r => r.uid !== b.dataset.u); if (!d.feastRows[k].length && !C.isOwnKey(k)) delete d.feastMode[k]; changed(); renderFeasts(); }));
  // Own feasts: name (typed in place), day (re-drawn), removal with its times; adding one (Sunday order to start with).
  const ownOf = k => d.own.find(f => f.key === k);
  sec.querySelectorAll("[data-of]").forEach(el => el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
    const o = ownOf(el.dataset.of), [m, dd] = o.md.split("-").map(Number);
    if (el.dataset.f === "name") { o.name = el.value; $("#fh-" + o.key).textContent = el.value.trim() || "Saját ünnep"; changed(el); return; }
    o.md = el.dataset.f === "m" ? mdFrom(+el.value, dd) : mdFrom(m, +el.value); changed(); renderFeasts();
  }));
  sec.querySelectorAll("[data-ofdel]").forEach(b => b.addEventListener("click", () => { const k = b.dataset.ofdel; d.own = d.own.filter(f => f.key !== k); delete d.feastMode[k]; delete d.feastRows[k]; changed(); renderFeasts(); }));
  sec.querySelector('[data-ofnew][data-f="m"]').addEventListener("change", e => { const s = sec.querySelector('[data-ofnew][data-f="d"]'); s.innerHTML = dayOptions(+e.target.value, +s.value); });
  $("#of-name").addEventListener("input", e => e.target.closest(".ui-field").classList.remove("err"));
  $("#of-add").addEventListener("click", () => {
    const name = $("#of-name").value.trim(); if (!name) { $("#of-name").closest(".ui-field").classList.add("err"); $("#of-name").focus(); return; }
    if (d.own.length >= C.OWN_FEASTS_MAX) return;
    const k = C.newOwnKey(d.own);
    d.own.push({ key: k, name, md: mdFrom(+sec.querySelector('[data-ofnew][data-f="m"]').value, +sec.querySelector('[data-ofnew][data-f="d"]').value) });
    d.feastMode[k] = "sunday"; changed(); renderFeasts();
  });
  marks();
}

/* ---------- Events ---------- */
function renderEvents() {
  const t = ymd(today()), d = P.d, up = d.events.filter(e => !e.date || e.date >= t), past = d.events.length - up.length;
  $("#sec").innerHTML = `<p class="pp-lead">Egyszeri alkalmak: búcsú, bérmálás, koncert, lelkigyakorlat. A térképen a templom oldalán, a közelgő események között látszanak.</p>
    <div class="pp-list">${up.map(e => `<div class="pp-card" data-chg="e:${e.uid}"><div class="pp-line">
      <label class="ui-field d"><span>Dátum</span><input type="date" data-ev="${e.uid}" data-f="date" value="${esc(e.date)}" min="${t}"></label>
      <label class="ui-field t"><span>Kezdés</span><input type="time" data-ev="${e.uid}" data-f="start" value="${esc(e.start)}"></label>
      <label class="ui-field wide"><span>Megnevezés</span><input data-ev="${e.uid}" data-f="title" value="${esc(e.title)}" maxlength="200" placeholder="pl. Búcsúi szentmise"></label>
      <label class="ui-field wide"><span>Megjegyzés</span><input data-ev="${e.uid}" data-f="note" value="${esc(e.note)}"></label>
      <button type="button" class="ui-btn danger" data-evdel="${e.uid}">Törlés</button></div></div>`).join("") || `<p class="pp-muted">Nincs közelgő esemény.</p>`}
      <button type="button" class="ui-btn secondary pp-add" id="ev-add">＋ Esemény</button></div>
    ${past ? `<p class="pp-muted pp-past">${past} korábbi esemény az archívumban marad.</p>` : ""}`;
  $("#sec").querySelectorAll("[data-ev]").forEach(el => el.addEventListener("input", () => { d.events.find(e => e.uid === el.dataset.ev)[el.dataset.f] = el.value; changed(el); }));
  $("#sec").querySelectorAll("[data-evdel]").forEach(b => b.addEventListener("click", () => { d.events = d.events.filter(e => e.uid !== b.dataset.evdel); changed(); renderEvents(); }));
  $("#ev-add").addEventListener("click", () => { d.events.push({ uid: uid(), date: "", start: "", title: "", note: "" }); changed(); renderEvents(); $("#sec").querySelectorAll("[data-f=date]")[up.length]?.focus(); });
  marks();
}

/* ---------- Church details ---------- */
function renderData() {
  const d = P.d, c = P.church;
  $("#sec").innerHTML = `<div class="pp-list">
    <section class="pp-card" aria-labelledby="ph-h"><div><h3 id="ph-h">Fotó</h3><span class="when">A térképen a templom oldalának tetején látszik</span></div><div id="photo"></div></section>
    <div class="pp-card" data-chg="contact"><h3>Elérhetőség</h3><div class="pp-line">
      <label class="ui-field"><span>Telefonszám</span><input data-k="phone" type="tel" value="${esc(d.phone)}"></label>
      <label class="ui-field"><span>Weboldal</span><input data-k="website" type="url" value="${esc(d.website)}" placeholder="https://"></label>
      <label class="ui-field wide"><span>Cím</span><input data-k="address" value="${esc(d.address)}"></label></div>
      <p class="pp-muted">A templom neve (${esc(c.name)}) és helye a térképen csak nálunk módosítható. Ha hibás, írd meg a megjegyzésben vagy a térképen a „Javítás beküldése” gombbal.</p></div>
    <div class="pp-card" data-chg="hours"><div><h3>Nyitvatartás</h3><span class="when">Mikor lehet bemenni imádkozni</span></div>
      <label class="pp-check"><input type="checkbox" class="ui-toggle" data-k="open_only_services" ${d.open_only_services ? "checked" : ""}><span>Csak a szertartások idején van nyitva</span></label>
      ${d.hours.map(h => `<div class="pp-hours" role="group" aria-label="Nyitvatartás"><div class="ui-daypick" role="group" aria-label="Napok">${DAYS.map(x => `<button type="button" data-hd="${h.uid}" data-d="${x}" aria-pressed="${h.days.includes(x)}" aria-label="${DAY_NAME[x]}">${DAY_SHORT[x]}</button>`).join("")}</div>
        <div class="pp-line"><label class="ui-field t"><span>Nyit</span><input type="time" data-h="${h.uid}" data-f="opens" value="${esc(h.opens)}"></label>
        <label class="ui-field t"><span>Zár</span><input type="time" data-h="${h.uid}" data-f="closes" value="${esc(h.closes)}"></label>
        <button type="button" class="ui-btn danger" data-hdel="${h.uid}">Törlés</button></div></div>`).join("")}
      <button type="button" class="ui-btn secondary pp-add" id="h-add">＋ Nyitvatartás</button></div>
    <div class="pp-card" data-chg="note"><div><h3>Megjegyzés a miserendhez</h3><span class="when">A hívek a miserend alatt látják</span></div>
      <label class="ui-field"><span hidden>Megjegyzés a miserendhez</span><textarea data-k="schedule_note" maxlength="1500" rows="4" placeholder="pl. Nyári szünetben a hétköznapi misék a plébániatemplomban vannak. Gyóntatás előzetes egyeztetéssel is: 06 30 …">${esc(d.schedule_note)}</textarea></label></div></div>`;
  const sec = $("#sec");
  window.ChurchPhoto.mount($("#photo"), { sb, church: c, admin: P.staff?.role === "admin", toast });
  sec.querySelectorAll("[data-k]").forEach(el => el.addEventListener(el.type === "checkbox" ? "change" : "input", () => { d[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value; changed(el.type === "checkbox" ? null : el); }));
  sec.querySelectorAll("[data-h]").forEach(el => el.addEventListener("input", () => { d.hours.find(h => h.uid === el.dataset.h)[el.dataset.f] = el.value; changed(el); }));
  sec.querySelectorAll("[data-hd]").forEach(b => b.addEventListener("click", () => { const h = d.hours.find(h => h.uid === b.dataset.hd), x = +b.dataset.d; h.days = h.days.includes(x) ? h.days.filter(y => y !== x) : [...h.days, x]; b.setAttribute("aria-pressed", h.days.includes(x)); changed(); }));
  sec.querySelectorAll("[data-hdel]").forEach(b => b.addEventListener("click", () => { d.hours = d.hours.filter(h => h.uid !== b.dataset.hdel); changed(); renderData(); }));
  $("#h-add").addEventListener("click", () => { d.hours.push({ uid: uid(), days: [1, 2, 3, 4, 5, 6, 0], opens: "08:00", closes: "18:00" }); changed(); renderData(); });
  marks();
}

/* ---------- What the faithful will see: the next 7 days ---------- */
function dayList(date, items) {
  // The church's own feast on this day comes first (as on the map, app.js dayInfo).
  const d = P.d, mine = C.ownFeastsOn(d.own, date), feasts = [...mine.map(f => f.key), ...C.feastsOn(date)], dow = date.getDay();
  const custom = feasts.filter(k => d.feastMode[k] === "custom" && (d.feastRows[k] || []).length);
  const own = custom.filter(k => !C.isGroup(k)), ofMine = own.filter(k => mine.some(f => f.key === k));
  const use = ofMine.length ? ofMine : mine.some(f => d.feastMode[f.key] === "sunday") ? [] : own.length ? own : custom;
  const fname = mine.length ? feastName(mine[0].key) : feasts.length ? C.FEAST_BY_KEY[feasts[0]]?.name : "";
  if (use.length) return { feast: fname, rows: use.flatMap(k => d.feastRows[k]).filter(r => TIME_RE.test(r.start)) };
  const sunday = feasts.some(k => d.feastMode[k] === "sunday");
  const holiday = C.isHoliday(date), advent = C.inAdvent(date);
  const rows = items.filter(i => sunday
    ? i.day === 0 && i.kind !== "rorate" && C.inPeriod(date, i.period, i.valid) && !i.weeks.length && !(+i.every > 1)
    : i.day === dow && C.inPeriod(date, i.period, i.valid) && C.weekOk(date, i.weeks) && C.everyOk(date, +i.every > 1 ? +i.every : null, i.anchor) && (i.kind !== "rorate" || advent) && !(i.feast_skip && holiday));
  return { feast: fname ? fname + (sunday ? " · vasárnapi rend" : "") : "", rows };
}
// Times in order, each run of the same kind followed by its word: "08:00 · 10:00 mise · 17:30 gyónás" (the times in
// 800, as on the map's week).
function timesHTML(rows) {
  const groups = [];
  for (const r of rows) {
    const w = r.kind === "prayer" ? (r.note || "").trim() || "imaóra" : PV_WORD[r.kind] || r.kind, last = groups[groups.length - 1];
    if (last && last.w === w) last.t.push(r.start); else groups.push({ w, t: [r.start] });
  }
  return groups.map(g => g.t.map(t => `<b>${esc(t)}</b>`).join(" · ") + " " + esc(g.w)).join(" · ");
}
// The next seven days as a board: NAP | IDŐPONTOK, today on a sunken row; while something is unsaved, a pale amber
// line says the preview already shows it.
function renderPreview() {
  const box = $("#preview"); if (!box) return;
  const t = today(), items = SE.split(P.d.rules).filter(i => i.day !== null);
  box.innerHTML = `<h2>Így látják a hívek</h2><p class="pv-sub">A térképen a templom oldala a következő hét napra.</p>${P.dirty ? `<p class="pv-note">A nem mentett változásokkal együtt; mentés után így lesz.</p>` : ""}
    <div class="pv-cols" aria-hidden="true"><span>Nap</span><span>Időpontok</span></div>
    <ul class="ui-glist pv-list">${Array.from({ length: 7 }, (_, n) => C.addDays(t, n)).map((date, n) => { const x = dayList(date, items); const rows = [...x.rows].sort((a, b) => a.start.localeCompare(b.start));
      return `<li class="ui-row pv-row${n ? "" : " today"}"${n ? "" : ` aria-current="date"`}><span class="d"><b>${DAY_NAME[date.getDay()]}</b>${dateText(date)}</span><span class="t">${rows.length ? timesHTML(rows) : `<span class="none">nincs</span>`}${x.feast ? `<span class="f">${esc(x.feast)}</span>` : ""}</span></li>`; }).join("")}</ul>
    <a class="ui-btn secondary pv-map" href="./#t=${+P.church.id}" target="_blank" rel="noopener">Megnézem a térképen</a>`;
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
    own_feasts: d.own.map(f => ({ key: f.key, name: f.name.trim(), md: f.md })),
    importance_manual: c.importance_manual ?? "", schedule_note: d.schedule_note.trim(), location_approx: c.location_approx, schedule_locked: true,
    hours: d.hours.filter(h => h.days.length && TIME_RE.test(h.opens) && TIME_RE.test(h.closes)).map(h => ({ days: h.days, opens: h.opens, closes: h.closes })),
    services, events: d.events.filter(e => e.date && e.title.trim()).map(e => ({ date: e.date, start: e.start, title: e.title.trim(), note: e.note.trim() })) };
}
function problems() {
  const d = P.d;
  for (const f of d.own) if (!f.name.trim()) return ["Saját ünnep: add meg a nevét.", "feasts"];
  for (const [k, m] of Object.entries(d.feastMode)) if (m === "custom") {
    if (C.isOwnKey(k) && !(d.feastRows[k] || []).length) return [`${feastName(k)}: adj meg legalább egy időpontot, vagy válaszd a vasárnapi rendet.`, "feasts"];
    for (const r of d.feastRows[k] || []) {
      if (!TIME_RE.test(r.start)) return [`${feastName(k)}: add meg az időpontot, vagy töröld a sort.`, "feasts"];
      if (r.kind !== "mass" && r.end && r.end <= r.start) return [`${feastName(k)}: a vége legyen később, mint a kezdés.`, "feasts"];
    }
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
  const published = P.church.published, id = P.church.id;
  // Saved: the amber lets go (the rows and times fade, the bar leaves), then the church is read back quietly.
  P.base = snapshot(P.d);
  P.se?.setBaseline(P.d.rules);
  SE.settle(document.querySelectorAll("#main .chg, #top .chg"));
  setDirty(false); renderTop(); renderPreview();
  toast(published ? "Elmentve · már látszik a térképen" : "Elmentve");
  await new Promise(r => setTimeout(r, reduced() ? 0 : 650));
  if (!P.dirty && P.view === "church" && P.church?.id === id) await openChurch(id, { quiet: true });
});
// Phones: show the preview; laptops: it is already beside the editor, bring it into view.
$("#pv-go").addEventListener("click", () => {
  if (matchMedia("(max-width: 979.98px)").matches) { setMode("preview"); window.scrollTo({ top: 0 }); }
  else $("#preview")?.scrollIntoView({ block: "nearest" });
});
