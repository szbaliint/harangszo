"use strict";
/* Harangszó for parishes: one church at a time, its week as a notice board, plain questions instead of settings.
   Permissions are enforced by the database (row level security + save_church); this page only shows what the
   signed-in parish may change. Admins can open any church here with ?templom=<id>. */

const CFG = window.HARANGSZO_CONFIG || {};
const C = window.LitCal;
const real = v => typeof v === "string" && v && !v.startsWith("__");
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const main = $("#main"), dlg = $("#ed");
const hm = t => t ? String(t).slice(0, 5) : "";
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAYS = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAME = ["Vasárnap", "Hétfő", "Kedd", "Szerda", "Csütörtök", "Péntek", "Szombat"];
const DAY_SHORT = ["V", "H", "K", "Sze", "Cs", "P", "Szo"];
const MON = ["jan.", "febr.", "márc.", "ápr.", "máj.", "jún.", "júl.", "aug.", "szept.", "okt.", "nov.", "dec."];
const KIND = { mass: "Szentmise", confession: "Gyóntatás", adoration: "Szentségimádás", prayer: "Imaóra, ájtatosság", rorate: "Rorate (adventi hajnali mise)" };
const KIND_SHORT = { mass: "", confession: "gyóntatás", adoration: "szentségimádás", prayer: "", rorate: "rorate, adventben" };
const PERIODS = [
  ["all", "Egész évben"],
  ["summer_months", "Nyáron", "június 1. – augusztus 31."],
  ["winter_months", "Télen", "december 1. – február vége"],
  ["summer", "Nyári időszámítás idején", "márciusi óraátállítástól októberiig"],
  ["winter", "Téli időszámítás idején", "októberi óraátállítástól márciusiig"],
  ["school", "Tanévben", "szeptember 1. – június 15."],
  ["holiday", "Nyári szünetben", "június 16. – augusztus 31."],
  ["advent", "Adventben", "advent első vasárnapjától dec. 24-ig"],
  ["christmas", "Karácsonyi időben", "dec. 25. – Urunk megkeresztelkedése"],
  ["lent", "Nagyböjtben", "hamvazószerdától nagyszombatig"],
  ["eastertide", "Húsvéti időben", "húsvéttól pünkösdig"],
  ["custom", "Saját időszakban", "megadod, mettől meddig"],
];
const PERIOD_SHORT = { summer_months: "nyáron", winter_months: "télen", summer: "nyári időszámításkor", winter: "téli időszámításkor", school: "tanévben", holiday: "nyári szünetben",
  advent: "adventben", christmas: "karácsonyi időben", lent: "nagyböjtben", eastertide: "húsvéti időben", autumn: "ősszel", spring: "tavasszal" };
const TAGS = ["solemn", "family", "student", "youth", "university", "guitar", "organ", "choir", "silent", "vigil", "traditional", "word", "confession", "irregular"];
const ORD = { 1: "első", 2: "második", 3: "harmadik", 4: "negyedik", 5: "ötödik", "-1": "utolsó" };
const FEAST_KIND = { mass: "Szentmise", confession: "Gyóntatás", adoration: "Szentségimádás" };

if (!real(CFG.supabaseUrl) || !real(CFG.supabaseAnonKey) || !window.supabase) {
  main.innerHTML = `<div class="card narrow"><h2>Az oldal még nincs beállítva</h2><p class="lead">Az adatbázis elérése hiányzik. Szólj a Harangszó gazdájának.</p></div>`;
  throw new Error("not configured");
}
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
const P = { user: null, staff: null, ids: [], church: null, d: null, tab: "week", dirty: false, savedAt: null };
let uidN = 0; const uid = () => "i" + (++uidN);
const ymd = d => C.ymd(d);
const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const fromYmd = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const dateText = d => `${MON[d.getMonth()]} ${d.getDate()}.`;

/* ---------- Sign-in ---------- */
function renderAuth(mode = "login", msg = "", ok = false) {
  $("#who").innerHTML = ""; $("#savebar").hidden = true;
  const titles = { login: "Belépés", signup: "Fiók létrehozása", forgot: "Új jelszó kérése", reset: "Új jelszó megadása" };
  main.innerHTML = `<form class="card narrow" id="auth" novalidate>
    <h1 class="title">${titles[mode]}</h1>
    ${mode === "login" ? `<p class="lead">Itt töltheti fel a plébánia, mikor van szentmise, gyóntatás és szentségimádás a templomban. A hívek a Harangszó térképén látják.</p>` : ""}
    ${mode === "signup" ? `<p class="lead">Az első belépés után kiválasztod a templomodat, és mi jóváhagyjuk a hozzáférést.</p>
      <label class="field"><span>Neved</span><input id="a-name" autocomplete="name" required></label>` : ""}
    ${mode !== "reset" ? `<label class="field"><span>E-mail-cím</span><input id="a-em" type="email" autocomplete="username" required></label>` : ""}
    ${mode === "login" || mode === "signup" || mode === "reset" ? `<label class="field"><span>${mode === "reset" ? "Új jelszó" : "Jelszó"}</span><input id="a-pw" type="password" autocomplete="${mode === "login" ? "current-password" : "new-password"}" minlength="8" required>${mode !== "login" ? "<small>Legalább 8 karakter.</small>" : ""}</label>` : ""}
    <button class="btn primary" type="submit">${{ login: "Belépés", signup: "Fiók létrehozása", forgot: "Levél küldése", reset: "Jelszó mentése" }[mode]}</button>
    <p class="msg ${ok ? "ok" : "err"}" id="a-msg" role="alert">${esc(msg)}</p>
    <div class="row">
      ${mode === "login" ? `<button type="button" class="btn quiet" data-mode="signup">Még nincs fiókom</button><button type="button" class="btn quiet" data-mode="forgot">Elfelejtettem a jelszót</button>` : `<button type="button" class="btn quiet" data-mode="login">Vissza a belépéshez</button>`}
    </div>
  </form>`;
  main.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => renderAuth(b.dataset.mode)));
  $("#auth").addEventListener("submit", async e => {
    e.preventDefault();
    const m = $("#a-msg"), say = (t, good) => { m.textContent = t; m.className = "msg " + (good ? "ok" : "err"); };
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
  else { P.user = null; renderAuth(); }
});
sb.auth.getSession().then(({ data }) => { if (!data.session) renderAuth(); });

async function afterLogin(user) {
  P.user = user;
  const { data: staff } = await sb.from("staff").select("role,display_name").eq("user_id", user.id).maybeSingle();
  P.staff = staff;
  const isAdmin = staff?.role === "admin";
  $("#who").innerHTML = `<span>${esc(staff?.display_name || user.user_metadata?.name || user.email)}</span>${isAdmin ? `<a class="btn" href="admin.html">Adminisztrátori felület</a>` : ""}<button class="btn" id="logout" type="button">Kilépés</button>`;
  $("#logout").addEventListener("click", async () => { if (P.dirty && !confirm("Vannak nem mentett változások. Biztosan kilépsz?")) return; P.dirty = false; await sb.auth.signOut(); });
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
function renderPicker(list, admin = false) {
  $("#savebar").hidden = true;
  main.innerHTML = `<div class="narrow" style="max-width:640px">
    <h1 class="title">Melyik templom miserendjét szerkeszted?</h1>
    ${admin ? `<p class="lead">Adminisztrátorként bármelyik templomot megnyithatod úgy, ahogy a plébániák látják.</p>
      <label class="field"><span>Templom vagy település</span><input id="pk-q" type="search" autocomplete="off" placeholder="pl. Szent Anna, Eger"></label>` : ""}
    <ul class="results" id="pk-list">${list.map(c => `<li><button type="button" data-id="${c.id}"><b>${esc(c.name)}</b><small>${esc(c.city || "")}</small></button></li>`).join("")}</ul>
  </div>`;
  const bind = () => $("#pk-list").querySelectorAll("button").forEach(b => b.addEventListener("click", () => { history.replaceState(null, "", "?templom=" + b.dataset.id); openChurch(+b.dataset.id); }));
  bind();
  if (admin) { let t; $("#pk-q").addEventListener("input", e => { clearTimeout(t); t = setTimeout(async () => { $("#pk-list").innerHTML = (await searchChurches(e.target.value)).map(c => `<li><button type="button" data-id="${c.id}"><b>${esc(c.name)}</b><small>${esc(c.city || "")}</small></button></li>`).join(""); bind(); }, 250); }); $("#pk-q").focus(); }
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
  $("#savebar").hidden = true;
  const { data: mine } = await sb.from("access_requests").select("id,status,created_at,church_id,churches(name,city)").order("created_at", { ascending: false });
  const name = (() => { try { return sessionStorage.getItem("pp-name"); } catch (_) { return ""; } })() || P.user.user_metadata?.name || "";
  let chosen = null;
  main.innerHTML = `<div class="narrow" style="max-width:640px">
    <h1 class="title">Melyik templomot szerkesztenéd?</h1>
    <p class="lead">Válaszd ki a templomot, és írd meg, ki vagy. Ha jóváhagytuk, ezen az oldalon rögtön szerkesztheted a miserendjét. Ha több templomot is gondozol (filiák), mindegyikhez kérj hozzáférést.</p>
    ${(mine || []).length ? `<div class="card" style="display:grid;gap:10px"><h2>Eddigi kéréseid</h2>${mine.map(r => `<div class="row" style="justify-content:space-between"><span><b>${esc(r.churches?.name || "#" + r.church_id)}</b> <span class="muted">${esc(r.churches?.city || "")}</span></span><span class="status ${r.status}">${{ pending: "jóváhagyásra vár", approved: "jóváhagyva – frissítsd az oldalt", rejected: "elutasítva" }[r.status]}</span></div>`).join("")}</div>` : ""}
    <form class="card" id="rq" style="display:grid;gap:14px" novalidate>
      <label class="field"><span>Templom keresése</span><input id="rq-q" type="search" autocomplete="off" placeholder="A templom neve vagy a település"></label>
      <ul class="results" id="rq-list"></ul>
      <label class="field"><span>Neved</span><input id="rq-name" value="${esc(name)}" autocomplete="name" required></label>
      <label class="field"><span>Mi a szereped a plébánián?</span><input id="rq-pos" placeholder="pl. plébános, irodavezető, sekrestyés"></label>
      <label class="field"><span>Telefonszám, ha visszahívnánk</span><input id="rq-phone" type="tel" autocomplete="tel"></label>
      <label class="field"><span>Üzenet (nem kötelező)</span><textarea id="rq-msg" maxlength="600"></textarea></label>
      <button class="btn primary" type="submit">Hozzáférés kérése</button>
      <p class="msg" id="rq-out" role="alert"></p>
    </form></div>`;
  let t;
  $("#rq-q").addEventListener("input", e => { clearTimeout(t); t = setTimeout(async () => {
    const list = await searchChurches(e.target.value);
    $("#rq-list").innerHTML = list.map(c => `<li><button type="button" data-id="${c.id}" aria-pressed="${chosen === c.id}"><b>${esc(c.name)}</b><small>${esc(c.city || "")}</small></button></li>`).join("") || (e.target.value.trim().length > 1 ? `<li class="muted">Nincs találat. Próbáld a település nevével.</li>` : "");
    $("#rq-list").querySelectorAll("button").forEach(b => b.addEventListener("click", () => { chosen = +b.dataset.id; $("#rq-list").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b)); }));
  }, 250); });
  $("#rq").addEventListener("submit", async e => {
    e.preventDefault(); const out = $("#rq-out");
    if (!chosen) { out.textContent = "Válaszd ki a templomot a listából."; out.className = "msg err"; return; }
    const nm = $("#rq-name").value.trim(); if (nm.length < 2) { out.textContent = "Írd be a neved."; out.className = "msg err"; return; }
    const { error } = await sb.from("access_requests").insert({ church_id: chosen, name: nm, position: $("#rq-pos").value.trim() || null, phone: $("#rq-phone").value.trim() || null, message: $("#rq-msg").value.trim() || null });
    if (error) { out.textContent = /duplicate|unique/i.test(error.message) ? "Ehhez a templomhoz már kértél hozzáférést." : "Nem sikerült elküldeni: " + error.message; out.className = "msg err"; return; }
    renderRequest();
  });
}

/* ---------- Loading a church into an editable draft ---------- */
const itemOf = (s, day) => ({ uid: uid(), day, kind: s.kind, start: hm(s.start_time ?? s.start), end: hm(s.end_time ?? s.end), note: s.note || "", period: s.period || "all", valid: s.valid || "",
  weeks: s.weeks || [], every: s.every || 1, anchor: s.anchor || "", tags: s.tags || [], celebrant: s.celebrant || "", place: s.place || "", place_church_id: s.place_church_id || null, feast_skip: !!s.feast_skip });
async function openChurch(id) {
  if (P.dirty && !confirm("Vannak nem mentett változások. Eldobod őket?")) return;
  main.innerHTML = `<p class="muted">Betöltés…</p>`;
  const { data: c, error } = await sb.from("churches").select("*, opening_hours(*), services!services_church_id_fkey(*), events(*)").eq("id", id).single();
  if (error || !c) { main.innerHTML = `<div class="card narrow"><h2>Ezt a templomot nem tudod megnyitni</h2><p class="lead">Lehet, hogy még nincs hozzáférésed hozzá.</p></div>`; return; }
  P.church = c;
  const feastMode = {}, feastRows = {};
  for (const k of c.feast_sunday || []) feastMode[k] = "sunday";
  for (const s of c.services.filter(s => s.feast).sort((a, b) => String(a.start_time).localeCompare(b.start_time))) {
    feastMode[s.feast] = "custom"; (feastRows[s.feast] ||= []).push({ uid: uid(), kind: s.kind === "rorate" ? "mass" : s.kind, start: hm(s.start_time), end: hm(s.end_time), note: s.note || "", celebrant: s.celebrant || "", place: s.place || "" });
  }
  P.d = {
    items: c.services.filter(s => !s.feast).flatMap(s => s.days.map(d => itemOf(s, d))),
    feastMode, feastRows,
    events: c.events.sort((a, b) => String(a.date).localeCompare(b.date)).map(e => ({ uid: uid(), date: e.date, start: hm(e.start_time), title: e.title, note: e.note || "" })),
    hours: c.opening_hours.map(h => ({ uid: uid(), days: h.days, opens: hm(h.opens), closes: hm(h.closes) })),
    phone: c.phone || "", website: c.website || "", address: c.address || "", schedule_note: c.schedule_note || "", open_only_services: !!c.open_only_services,
  };
  setDirty(false);
  renderChurch();
}
function setDirty(v) {
  P.dirty = v;
  $("#savebar").hidden = !P.church;
  const st = $("#savestate");
  st.className = "state" + (v ? " dirty" : "");
  st.textContent = v ? "Nem mentett változások" : P.savedAt ? `Elmentve ${P.savedAt}. A térképen az oldal frissítése után látszik.` : "Minden mentve.";
  $("#save").disabled = !v;
}
window.addEventListener("beforeunload", e => { if (P.dirty) { e.preventDefault(); e.returnValue = ""; } });

/* ---------- Page ---------- */
const SECTIONS = { week: "Heti miserend", feasts: "Ünnepek", events: "Események", data: "Templom adatai" };
function renderChurch() {
  const c = P.church;
  const imported = c.schedule_source && !c.parish_updated_at && P.d.items.length;
  main.innerHTML = `<div class="head"><h1 class="title">${esc(c.name)}</h1><span class="place">${esc([c.city, c.address].filter(Boolean).join(", "))}</span></div>
    ${imported ? `<p class="notice">Ezeket az időpontokat máshonnan (${c.schedule_source === "miserend" ? "a miserend.hu oldalról" : "az egyházmegye honlapjáról"}) vettük át. Nézd át őket, javítsd, ami nem stimmel, és mentsd el. Ezután a te adataid számítanak, és semmilyen automatikus frissítés nem írja felül őket.</p>` : ""}
    ${P.ids.length > 1 ? `<p><button class="btn quiet" id="other" type="button">Másik templomot szerkesztek</button></p>` : ""}
    <nav class="sections" aria-label="Részek">${Object.entries(SECTIONS).map(([k, v]) => `<button type="button" data-sec="${k}" aria-current="${P.tab === k}">${v}</button>`).join("")}</nav>
    <div class="cols"><section id="sec"></section><aside class="card preview" id="preview"></aside></div>`;
  main.querySelectorAll("[data-sec]").forEach(b => b.addEventListener("click", () => { P.tab = b.dataset.sec; main.querySelectorAll("[data-sec]").forEach(x => x.setAttribute("aria-current", x === b)); renderSection(); }));
  $("#other")?.addEventListener("click", async () => { const { data } = await sb.from("churches").select("id,name,city").in("id", P.ids); renderPicker(data || []); });
  renderSection(); renderPreview();
}
function renderSection() { ({ week: renderWeek, feasts: renderFeasts, events: renderEvents, data: renderData })[P.tab](); }
function changed() { setDirty(true); renderPreview(); }

/* ---------- Describing a time in words ---------- */
function freqText(it) {
  if (+it.every > 1) return ({ 2: "kéthetente", 3: "háromhetente", 4: "négyhetente" })[it.every] || it.every + " hetente";
  if (it.weeks?.length) return "a hónap " + it.weeks.map(n => ORD[n]).join(" és ") + " hetén";
  return "";
}
const rangeText = v => v.split(",").map(r => r.split("/").map(x => { const [m, d] = x.split("-").map(Number); return `${MON[m - 1]} ${d}.`; }).join("–")).join(", ");
function describe(it) {
  return [it.kind === "confession" ? `gyóntatás${it.end ? " " + it.end + "-ig" : ""}` : it.kind === "prayer" ? it.note || "ájtatosság" : KIND_SHORT[it.kind] + (it.kind === "adoration" && it.end ? " " + it.end + "-ig" : ""),
    freqText(it), it.valid ? rangeText(it.valid) : PERIOD_SHORT[it.period] || "", it.feast_skip ? "ünnepnapokon nincs" : "",
    it.place ? "helyszín: " + it.place : "", it.celebrant ? it.celebrant : "", (it.tags || []).map(C.tagLabel).join(", "), it.kind === "prayer" ? "" : it.note].filter(Boolean).join(" · ");
}
const sig = it => JSON.stringify([it.kind, it.start, it.end, it.note, it.period, it.valid, it.weeks, +it.every || 1, it.anchor, [...(it.tags || [])].sort(), it.celebrant, it.place, it.place_church_id, it.feast_skip]);

/* ---------- Week board ---------- */
function renderWeek() {
  const byDay = d => P.d.items.filter(i => i.day === d).sort((a, b) => a.start.localeCompare(b.start));
  $("#sec").innerHTML = `<p class="lead" style="margin-bottom:14px">Koppints egy időpontra a módosításhoz. Ami minden héten ugyanígy van, azt egyszer kell felvenni: a hozzáadásnál több napot is kijelölhetsz.</p>
    <div class="board">${DAYS.map(d => `<div class="day ${d === 0 ? "sun" : ""}"><h3>${DAY_NAME[d]}</h3><div class="slots">
      ${byDay(d).map(i => `<button type="button" class="tslot k-${i.kind}" data-uid="${i.uid}"><b>${i.start}</b>${describe(i) ? `<span>${esc(describe(i))}</span>` : ""}</button>`).join("")}
      <button type="button" class="add" data-add="${d}" aria-label="Időpont hozzáadása: ${DAY_NAME[d]}">+ Időpont</button></div></div>`).join("")}</div>
    <p class="legend"><span><i style="background:var(--accent)"></i>szentmise</span><span><i style="background:var(--penance)"></i>gyóntatás</span><span><i style="background:var(--gold)"></i>szentségimádás, ájtatosság</span></p>`;
  $("#sec").querySelectorAll("[data-uid]").forEach(b => b.addEventListener("click", () => openEditor(P.d.items.find(i => i.uid === b.dataset.uid))));
  $("#sec").querySelectorAll("[data-add]").forEach(b => b.addEventListener("click", () => openEditor(null, +b.dataset.add)));
}

/* ---------- The time editor (dialog) ---------- */
let E = null;
const nextDow = (d, from = today()) => C.nextDate(from, x => x.getDay() === d);
const mondayOf = date => C.addDays(date, -((date.getDay() + 6) % 7));
const mdOfDate = s => s ? s.slice(5) : "";
function openEditor(item, day) {
  if (item) {
    const group = P.d.items.filter(i => sig(i) === sig(item) || (+item.every > 1 && i.uid === item.uid));
    const gs = +item.every > 1 ? [item] : group;
    E = { mode: "edit", uids: gs.map(i => i.uid), days: new Set(gs.map(i => i.day)), f: JSON.parse(JSON.stringify(item)), confirmDel: false };
  } else {
    E = { mode: "add", uids: [], days: new Set([day]), f: itemOf({ kind: "mass", start: "", period: "all" }, day), confirmDel: false };
  }
  E.f.periodSel = E.f.valid ? "custom" : E.f.period;
  E.f.freq = +E.f.every > 1 ? "every" : E.f.weeks?.length ? "weeks" : "weekly";
  if (E.f.valid) { const [a, b] = E.f.valid.split(",")[0].split("/"); const y = today().getFullYear(); E.f.from = `${y}-${a}`; E.f.to = `${y}-${b}`; }
  if (E.f.freq === "every" && !E.f.anchor) E.f.anchor = ymd(nextDow([...E.days][0]));
  E.f.where = E.f.place || E.f.place_church_id ? "else" : "here";
  renderEditor(); dlg.showModal();
  setTimeout(() => (E.mode === "add" ? $("#e-start") : $("#e-title"))?.focus(), 30);
}
function renderEditor() {
  const f = E.f, isMass = f.kind === "mass" || f.kind === "rorate", hasEnd = !isMass;
  const lang = (f.tags || []).find(t => t.startsWith("lang:"))?.slice(5) || "";
  const scroll = dlg.querySelector(".body")?.scrollTop || 0;
  dlg.innerHTML = `<form method="dialog" id="e-form" novalidate>
    <header><h2 id="ed-title" tabindex="-1">${E.mode === "add" ? "Új időpont" : "Időpont módosítása"}</h2><button type="button" class="btn quiet close" id="e-x">Bezárás</button></header>
    <div class="body">
      <div class="q"><span class="ql">Mi ez?</span><div class="toggles" role="group" aria-label="Fajta">${Object.entries(KIND).map(([k, v]) => `<button type="button" data-kind="${k}" aria-pressed="${f.kind === k}">${v}</button>`).join("")}</div>
        ${f.kind === "rorate" ? `<span class="qh">Csak adventben jelenik meg, magától.</span>` : ""}</div>
      ${f.kind === "prayer" ? `<label class="field"><span>Megnevezés</span><input id="e-note" value="${esc(f.note)}" placeholder="pl. Rózsafüzér, Vesperás, Keresztút"></label>` : ""}
      <div class="line"><label class="field t"><span>Kezdés</span><input id="e-start" type="time" value="${esc(f.start)}" required></label>
        ${hasEnd ? `<label class="field t"><span>Vége</span><input id="e-end" type="time" value="${esc(f.end)}"></label>` : ""}</div>
      <div class="q"><span class="ql">Melyik napokon?</span><div class="daypick" role="group" aria-label="Napok">${DAYS.map(d => `<button type="button" data-day="${d}" aria-pressed="${E.days.has(d)}">${DAY_SHORT[d]}</button>`).join("")}</div></div>
      <div class="q"><span class="ql">Milyen gyakran?</span><div class="opts">
        ${[["weekly", "Minden héten"], ["every", "Kéthetente vagy ritkábban"], ["weeks", "A hónap bizonyos hetein", "pl. minden hónap első péntekén"]].map(([k, v, h]) => `<label class="opt"><input type="radio" name="freq" value="${k}" ${f.freq === k ? "checked" : ""}><span>${v}${h ? `<small>${h}</small>` : ""}</span></label>`).join("")}</div>
        ${f.freq === "every" ? `<div class="line"><label class="field"><span>Hány hetente?</span><select id="e-every">${[2, 3, 4].map(n => `<option value="${n}" ${+f.every === n ? "selected" : ""}>${{ 2: "Kéthetente", 3: "Háromhetente", 4: "Négyhetente" }[n]}</option>`).join("")}</select></label>
          <label class="field"><span>Mikor lesz legközelebb?</span><input id="e-anchor" type="date" value="${esc(f.anchor)}"><small>Ebből számoljuk a többit.</small></label></div>` : ""}
        ${f.freq === "weeks" ? `<div class="daypick" role="group" aria-label="A hónap hetei">${[1, 2, 3, 4, 5, -1].map(n => `<button type="button" data-wk="${n}" aria-pressed="${(f.weeks || []).includes(n)}">${n === -1 ? "utolsó" : n + "."}</button>`).join("")}</div><span class="qh">Pl. az „1.” a hónap első ilyen napja.</span>` : ""}</div>
      ${f.kind === "rorate" ? "" : `<div class="q"><span class="ql">Az év melyik részében?</span><label class="field"><select id="e-period">${PERIODS.map(([k, v, h]) => `<option value="${k}" ${f.periodSel === k ? "selected" : ""}>${v}${h ? " (" + h + ")" : ""}</option>`).join("")}</select></label>
        ${f.periodSel === "custom" ? `<div class="line"><label class="field"><span>Ettől</span><input id="e-from" type="date" value="${esc(f.from || "")}"></label><label class="field"><span>Eddig</span><input id="e-to" type="date" value="${esc(f.to || "")}"></label></div><span class="qh">Minden évben ugyanebben az időszakban érvényes.</span>` : ""}
        <label class="check"><input type="checkbox" id="e-skip" ${f.feast_skip ? "checked" : ""}><span>Ünnepnapokon elmarad<small class="muted" style="display:block">Parancsolt ünnepeken és munkaszüneti napokon, ha nem vasárnapra esnek. Az ünnepi rendet az Ünnepek fülön adhatod meg.</small></span></label></div>`}
      <details class="more" ${f.celebrant || f.where === "else" || (f.tags || []).length || (isMass && f.note) ? "open" : ""}><summary>Részletek: ki tartja, hol, milyen mise</summary><div class="inner">
        <label class="field"><span>${f.kind === "confession" ? "Ki gyóntat?" : "Ki tartja?"}</span><input id="e-cel" value="${esc(f.celebrant)}" maxlength="80" placeholder="pl. plébános atya, P. Kamill"><small>Nem kötelező.</small></label>
        <div class="q"><span class="ql">Hol?</span><div class="opts">
          <label class="opt"><input type="radio" name="where" value="here" ${f.where === "here" ? "checked" : ""}><span>A templomban</span></label>
          <label class="opt"><input type="radio" name="where" value="else" ${f.where === "else" ? "checked" : ""}><span>Máshol<small>pl. temetőkápolna, kórház, idősek otthona</small></span></label></div>
          ${f.where === "else" ? `<label class="field"><span>Helyszín</span><input id="e-place" value="${esc(f.place)}" maxlength="120"></label>` : ""}</div>
        ${isMass ? `<div class="q"><span class="ql">Milyen mise?</span><div class="toggles" role="group" aria-label="Jellege">${TAGS.map(t => `<button type="button" data-tag="${t}" aria-pressed="${(f.tags || []).includes(t)}">${esc(C.TAGS[t])}</button>`).join("")}</div>
          <label class="field"><span>Nyelve</span><select id="e-lang"><option value="">magyar</option>${Object.entries(C.LANGS).filter(([k]) => k !== "hu").map(([k, v]) => `<option value="${k}" ${lang === k ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label></div>` : ""}
        ${f.kind === "prayer" ? "" : `<label class="field"><span>Megjegyzés</span><input id="e-note" value="${esc(f.note)}" maxlength="200" placeholder="pl. utána szentségimádás"></label>`}
      </div></details>
      <p class="msg err" id="e-msg" role="alert"></p>
    </div>
    <footer>${E.mode === "edit" ? `<button type="button" class="btn danger" id="e-del">${E.confirmDel ? "Biztosan törlöd?" : "Törlés"}</button>` : ""}<span class="grow"></span>
      <button type="button" class="btn" id="e-cancel">Mégse</button><button type="submit" class="btn primary">${E.mode === "add" ? "Hozzáadás" : "Kész"}</button></footer>
  </form>`;
  const body = dlg.querySelector(".body"); body.scrollTop = scroll;
  const read = () => {
    f.start = $("#e-start").value; f.end = $("#e-end")?.value ?? "";
    if ($("#e-note")) f.note = $("#e-note").value; if ($("#e-cel")) f.celebrant = $("#e-cel").value;
    if ($("#e-place")) f.place = $("#e-place").value;
    if ($("#e-every")) f.every = +$("#e-every").value; if ($("#e-anchor")) f.anchor = $("#e-anchor").value;
    if ($("#e-from")) { f.from = $("#e-from").value; f.to = $("#e-to").value; }
    if ($("#e-skip")) f.feast_skip = $("#e-skip").checked;
    const det = dlg.querySelector("details.more"); E.open = det?.open;
  };
  const rer = () => { read(); renderEditor(); if (E.open) dlg.querySelector("details.more").open = true; };
  dlg.querySelectorAll("[data-kind]").forEach(b => b.addEventListener("click", () => { read(); f.kind = b.dataset.kind; if (f.kind === "rorate") { f.period = "all"; f.periodSel = "all"; } rer(); }));
  dlg.querySelectorAll("[data-day]").forEach(b => b.addEventListener("click", () => { const d = +b.dataset.day; E.days.has(d) ? E.days.delete(d) : E.days.add(d); b.setAttribute("aria-pressed", E.days.has(d)); }));
  dlg.querySelectorAll("input[name=freq]").forEach(r => r.addEventListener("change", () => { read(); f.freq = r.value; if (f.freq === "every") { f.every = +f.every > 1 ? f.every : 2; f.anchor ||= ymd(nextDow([...E.days][0] ?? 0)); } rer(); }));
  dlg.querySelectorAll("input[name=where]").forEach(r => r.addEventListener("change", () => { read(); f.where = r.value; if (f.where === "here") { f.place = ""; f.place_church_id = null; } rer(); }));
  dlg.querySelectorAll("[data-wk]").forEach(b => b.addEventListener("click", () => { const n = +b.dataset.wk; f.weeks = (f.weeks || []).includes(n) ? f.weeks.filter(x => x !== n) : [...(f.weeks || []), n].sort((a, z) => (a < 0) - (z < 0) || a - z); b.setAttribute("aria-pressed", f.weeks.includes(n)); }));
  dlg.querySelectorAll("[data-tag]").forEach(b => b.addEventListener("click", () => { const t = b.dataset.tag; f.tags = (f.tags || []).includes(t) ? f.tags.filter(x => x !== t) : [...(f.tags || []), t]; b.setAttribute("aria-pressed", f.tags.includes(t)); }));
  $("#e-lang")?.addEventListener("change", e => { f.tags = [...(f.tags || []).filter(t => !t.startsWith("lang:")), ...(e.target.value ? ["lang:" + e.target.value] : [])]; });
  $("#e-period")?.addEventListener("change", e => { read(); f.periodSel = e.target.value; rer(); });
  $("#e-x").addEventListener("click", () => dlg.close()); $("#e-cancel").addEventListener("click", () => dlg.close());
  $("#e-del")?.addEventListener("click", () => {
    if (!E.confirmDel) { read(); E.confirmDel = true; return renderEditor(); }
    P.d.items = P.d.items.filter(i => !E.uids.includes(i.uid)); dlg.close(); changed(); renderWeek();
  });
  $("#e-form").addEventListener("submit", e => {
    e.preventDefault(); read();
    const err = msg => { $("#e-msg").textContent = msg; $("#e-msg").scrollIntoView({ block: "nearest" }); };
    if (!TIME_RE.test(f.start)) return err("Add meg, hánykor kezdődik.");
    if (f.end && !TIME_RE.test(f.end)) return err("A befejezés időpontja nem érvényes.");
    if (f.end && f.end <= f.start) return err("A vége legyen később, mint a kezdés.");
    if (!E.days.size) return err("Jelölj ki legalább egy napot.");
    if (f.kind === "prayer" && !f.note.trim()) return err("Írd be, milyen ájtatosság ez (pl. Rózsafüzér).");
    if (f.freq === "every" && !f.anchor) return err("Add meg, mikor lesz legközelebb.");
    if (f.freq === "weeks" && !(f.weeks || []).length) return err("Jelöld ki, a hónap melyik hetein van.");
    let valid = "";
    if (f.periodSel === "custom") { if (!f.from || !f.to) return err("Add meg az időszak elejét és végét."); valid = `${mdOfDate(f.from)}/${mdOfDate(f.to)}`; }
    if (f.where === "else" && !f.place.trim() && !f.place_church_id) return err("Írd be a helyszínt.");
    const base = { kind: f.kind, start: f.start, end: f.kind === "mass" || f.kind === "rorate" ? "" : f.end, note: f.note.trim(), period: f.kind === "rorate" || f.periodSel === "custom" ? "all" : f.periodSel,
      valid: f.kind === "rorate" ? "" : valid, weeks: f.freq === "weeks" ? f.weeks : [], every: f.freq === "every" ? +f.every : 1, tags: f.kind === "mass" || f.kind === "rorate" ? f.tags || [] : [],
      celebrant: f.celebrant.trim(), place: f.where === "else" ? f.place.trim() : "", place_church_id: f.where === "else" ? f.place_church_id : null, feast_skip: f.kind !== "rorate" && !!f.feast_skip };
    // "Kéthetente": each day's own date in the same week as the next occurrence the parish gave.
    const mon = f.freq === "every" ? mondayOf(fromYmd(f.anchor)) : null;
    const fresh = [...E.days].sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b)).map(d => ({ ...base, uid: uid(), day: d, anchor: mon ? ymd(C.addDays(mon, (d + 6) % 7)) : "" }));
    const keep = P.d.items.filter(i => !E.uids.includes(i.uid));
    P.d.items = [...keep, ...fresh.filter(n => !keep.some(k => k.day === n.day && sig(k) === sig(n)))];
    dlg.close(); changed(); renderWeek();
  });
}
dlg.addEventListener("close", () => { E = null; });

/* ---------- Feasts ---------- */
function renderFeasts() {
  const from = today(), d = P.d;
  const list = [...C.FEAST_GROUPS.map(g => ({ key: g.key, name: g.name, group: true, next: C.nextFeastDate(g.key, from) })),
    ...C.FEASTS.map(f => ({ key: f.key, name: f.name, next: C.nextFeastDate(f.key, from) })).sort((a, b) => a.next - b.next)];
  const groupHint = { holyday: "jan. 1., jan. 6., aug. 15., nov. 1., dec. 25., ha hétköznapra esik", public: "pl. márc. 15., nagypéntek, húsvét- és pünkösdhétfő, máj. 1., aug. 20., okt. 23., dec. 24–26." };
  const rows = k => d.feastRows[k] ||= [];
  $("#sec").innerHTML = `<p class="lead" style="margin-bottom:14px">Ha egy ünnepen másképp van mise, mint egyébként azon a napon, itt add meg. Amit nem állítasz be, azon a napon a heti miserend érvényes. A két csoportos sor minden ilyen napra vonatkozik; egy külön beállított ünnep erősebb náluk.</p>
    <div class="rows">${list.map(x => { const m = d.feastMode[x.key] || ""; return `<div class="rowcard"><div class="top"><h3>${esc(x.name)}</h3><span class="when">${x.group ? groupHint[x.key] : `${x.next.getFullYear()}. ${dateText(x.next)}, ${DAY_NAME[x.next.getDay()].toLowerCase()}`}</span></div>
      <label class="field"><span class="sr" hidden>Rend</span><select data-fm="${x.key}"><option value="" ${!m ? "selected" : ""}>Ahogy azon a napon egyébként</option><option value="sunday" ${m === "sunday" ? "selected" : ""}>Mint vasárnap</option><option value="custom" ${m === "custom" ? "selected" : ""}>Külön időpontok</option></select></label>
      ${m === "custom" ? `<div class="rows">${rows(x.key).map(r => `<div class="line">
          <label class="field"><span>Mi ez?</span><select data-fr="${x.key}" data-u="${r.uid}" data-f="kind">${Object.entries(FEAST_KIND).map(([k, v]) => `<option value="${k}" ${r.kind === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
          <label class="field t"><span>Kezdés</span><input type="time" data-fr="${x.key}" data-u="${r.uid}" data-f="start" value="${esc(r.start)}"></label>
          ${r.kind !== "mass" ? `<label class="field t"><span>Vége</span><input type="time" data-fr="${x.key}" data-u="${r.uid}" data-f="end" value="${esc(r.end)}"></label>` : ""}
          <label class="field"><span>Ki tartja?</span><input data-fr="${x.key}" data-u="${r.uid}" data-f="celebrant" value="${esc(r.celebrant)}" maxlength="80"></label>
          <label class="field wide"><span>Megjegyzés</span><input data-fr="${x.key}" data-u="${r.uid}" data-f="note" value="${esc(r.note)}" placeholder="${x.key === "dec24" ? "pl. éjféli mise (00:00-ként add meg)" : "pl. ünnepi nagymise"}"></label>
          <button type="button" class="x" data-frdel="${x.key}" data-u="${r.uid}" aria-label="Időpont törlése">Törlés</button></div>`).join("")}
        <div><button type="button" class="add" data-fradd="${x.key}">+ Időpont</button></div></div>` : ""}</div>`; }).join("")}</div>`;
  const sec = $("#sec");
  sec.querySelectorAll("[data-fm]").forEach(s => s.addEventListener("change", () => { const k = s.dataset.fm; if (s.value) d.feastMode[k] = s.value; else delete d.feastMode[k];
    if (s.value === "custom" && !rows(k).length) rows(k).push({ uid: uid(), kind: "mass", start: "", end: "", note: "", celebrant: "", place: "" }); changed(); renderFeasts(); }));
  sec.querySelectorAll("[data-fr]").forEach(el => el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => { const r = rows(el.dataset.fr).find(r => r.uid === el.dataset.u); r[el.dataset.f] = el.value; changed(); if (el.dataset.f === "kind") renderFeasts(); }));
  sec.querySelectorAll("[data-fradd]").forEach(b => b.addEventListener("click", () => { rows(b.dataset.fradd).push({ uid: uid(), kind: "mass", start: "", end: "", note: "", celebrant: "", place: "" }); changed(); renderFeasts(); }));
  sec.querySelectorAll("[data-frdel]").forEach(b => b.addEventListener("click", () => { const k = b.dataset.frdel; d.feastRows[k] = rows(k).filter(r => r.uid !== b.dataset.u); if (!d.feastRows[k].length) delete d.feastMode[k]; changed(); renderFeasts(); }));
}

/* ---------- Events ---------- */
function renderEvents() {
  const t = ymd(today()), d = P.d, up = d.events.filter(e => !e.date || e.date >= t), past = d.events.length - up.length;
  $("#sec").innerHTML = `<p class="lead" style="margin-bottom:14px">Egyszeri alkalmak: búcsú, bérmálás, koncert, lelkigyakorlat. A térképen a templom oldalán, a közelgő események között látszanak.</p>
    <div class="rows">${up.map(e => `<div class="rowcard"><div class="line">
      <label class="field t"><span>Dátum</span><input type="date" data-ev="${e.uid}" data-f="date" value="${esc(e.date)}" min="${t}"></label>
      <label class="field t"><span>Kezdés</span><input type="time" data-ev="${e.uid}" data-f="start" value="${esc(e.start)}"></label>
      <label class="field wide"><span>Megnevezés</span><input data-ev="${e.uid}" data-f="title" value="${esc(e.title)}" maxlength="200" placeholder="pl. Búcsúi szentmise"></label>
      <label class="field wide"><span>Megjegyzés</span><input data-ev="${e.uid}" data-f="note" value="${esc(e.note)}"></label>
      <button type="button" class="x" data-evdel="${e.uid}">Törlés</button></div></div>`).join("") || `<p class="muted">Nincs közelgő esemény.</p>`}
      <div><button type="button" class="add" id="ev-add">+ Esemény</button></div></div>
    ${past ? `<p class="muted">${past} korábbi esemény az archívumban marad.</p>` : ""}`;
  $("#sec").querySelectorAll("[data-ev]").forEach(el => el.addEventListener("input", () => { d.events.find(e => e.uid === el.dataset.ev)[el.dataset.f] = el.value; changed(); }));
  $("#sec").querySelectorAll("[data-evdel]").forEach(b => b.addEventListener("click", () => { d.events = d.events.filter(e => e.uid !== b.dataset.evdel); changed(); renderEvents(); }));
  $("#ev-add").addEventListener("click", () => { d.events.push({ uid: uid(), date: "", start: "", title: "", note: "" }); changed(); renderEvents(); $("#sec").querySelectorAll("[data-f=date]")[up.length]?.focus(); });
}

/* ---------- Church details ---------- */
function renderData() {
  const d = P.d, c = P.church;
  $("#sec").innerHTML = `<div class="rows">
    <div class="rowcard"><div class="line">
      <label class="field"><span>Telefonszám</span><input data-k="phone" type="tel" value="${esc(d.phone)}"></label>
      <label class="field"><span>Weboldal</span><input data-k="website" type="url" value="${esc(d.website)}" placeholder="https://"></label>
      <label class="field wide"><span>Cím</span><input data-k="address" value="${esc(d.address)}"></label></div>
      <p class="muted" style="margin:0">A templom neve (${esc(c.name)}) és helye a térképen csak nálunk módosítható. Ha hibás, írd meg a megjegyzésben vagy a térképen a „Javítás beküldése” gombbal.</p></div>
    <div class="rowcard"><div class="top"><h3>Nyitvatartás</h3><span class="when">Mikor lehet bemenni imádkozni</span></div>
      <label class="check"><input type="checkbox" data-k="open_only_services" ${d.open_only_services ? "checked" : ""}><span>Csak a szertartások idején van nyitva</span></label>
      ${d.hours.map(h => `<div class="line"><div class="field"><span>Napok</span><div class="daypick">${DAYS.map(x => `<button type="button" data-hd="${h.uid}" data-d="${x}" aria-pressed="${h.days.includes(x)}">${DAY_SHORT[x]}</button>`).join("")}</div></div>
        <label class="field t"><span>Nyit</span><input type="time" data-h="${h.uid}" data-f="opens" value="${esc(h.opens)}"></label>
        <label class="field t"><span>Zár</span><input type="time" data-h="${h.uid}" data-f="closes" value="${esc(h.closes)}"></label>
        <button type="button" class="x" data-hdel="${h.uid}">Törlés</button></div>`).join("")}
      <div><button type="button" class="add" id="h-add">+ Nyitvatartás</button></div></div>
    <div class="rowcard"><div class="top"><h3>Megjegyzés a miserendhez</h3><span class="when">A hívek a miserend alatt látják</span></div>
      <label class="field"><textarea data-k="schedule_note" maxlength="1500" placeholder="pl. Nyári szünetben a hétköznapi misék a plébániatemplomban vannak. Gyóntatás előzetes egyeztetéssel is: 06 30 …">${esc(d.schedule_note)}</textarea></label></div></div>`;
  const sec = $("#sec");
  sec.querySelectorAll("[data-k]").forEach(el => el.addEventListener(el.type === "checkbox" ? "change" : "input", () => { d[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value; changed(); }));
  sec.querySelectorAll("[data-h]").forEach(el => el.addEventListener("input", () => { d.hours.find(h => h.uid === el.dataset.h)[el.dataset.f] = el.value; changed(); }));
  sec.querySelectorAll("[data-hd]").forEach(b => b.addEventListener("click", () => { const h = d.hours.find(h => h.uid === b.dataset.hd), x = +b.dataset.d; h.days = h.days.includes(x) ? h.days.filter(y => y !== x) : [...h.days, x]; b.setAttribute("aria-pressed", h.days.includes(x)); changed(); }));
  sec.querySelectorAll("[data-hdel]").forEach(b => b.addEventListener("click", () => { d.hours = d.hours.filter(h => h.uid !== b.dataset.hdel); changed(); renderData(); }));
  $("#h-add").addEventListener("click", () => { d.hours.push({ uid: uid(), days: [1, 2, 3, 4, 5, 6, 0], opens: "08:00", closes: "18:00" }); changed(); renderData(); });
}

/* ---------- What the faithful will see: the next 7 days ---------- */
function dayList(date) {
  const d = P.d, feasts = C.feastsOn(date), dow = date.getDay();
  const custom = feasts.filter(k => d.feastMode[k] === "custom" && (d.feastRows[k] || []).length);
  const own = custom.filter(k => !C.isGroup(k)), use = own.length ? own : custom;
  const fname = feasts.length ? C.FEAST_BY_KEY[feasts[0]]?.name : "";
  if (use.length) return { feast: fname, rows: use.flatMap(k => d.feastRows[k]).filter(r => TIME_RE.test(r.start)) };
  const sunday = feasts.some(k => d.feastMode[k] === "sunday");
  const holiday = C.isHoliday(date), advent = C.inAdvent(date);
  const rows = d.items.filter(i => sunday
    ? i.day === 0 && i.kind !== "rorate" && C.inPeriod(date, i.period, i.valid) && !i.weeks.length && !(+i.every > 1)
    : i.day === dow && C.inPeriod(date, i.period, i.valid) && C.weekOk(date, i.weeks) && C.everyOk(date, +i.every > 1 ? +i.every : null, i.anchor) && (i.kind !== "rorate" || advent) && !(i.feast_skip && holiday));
  return { feast: fname ? fname + (sunday ? " · vasárnapi rend" : "") : "", rows };
}
function renderPreview() {
  const box = $("#preview"); if (!box) return;
  const t = today();
  box.innerHTML = `<h2>Így látják a hívek</h2><p class="muted" style="margin:0">A következő hét a mostani beállítások szerint${P.dirty ? ", mentés után" : ""}.</p>
    <div>${Array.from({ length: 7 }, (_, n) => C.addDays(t, n)).map(date => { const x = dayList(date); const rows = [...x.rows].sort((a, b) => a.start.localeCompare(b.start));
      return `<div class="pday"><span class="d"><b>${n0(date, t)}</b>${dateText(date)}</span><span>${x.feast ? `<span class="f">${esc(x.feast)}</span><br>` : ""}<span class="t">${rows.map(r => `${r.start}${r.kind !== "mass" && r.kind !== "rorate" ? ` <em>${esc(r.kind === "confession" ? "gyónás" : r.kind === "prayer" ? r.note : r.kind === "adoration" ? "szentségimádás" : "")}</em>` : r.kind === "rorate" ? " <em>rorate</em>" : ""}`).join(", ") || `<em>nincs</em>`}</span></span></div>`; }).join("")}</div>
    <a class="btn" href="./#t=${P.church.id}" target="_blank" rel="noopener">Megnézem a térképen</a>`;
}
const n0 = (date, t) => { const diff = Math.round((date - t) / 864e5); return diff === 0 ? "Ma" : diff === 1 ? "Holnap" : DAY_NAME[date.getDay()]; };

/* ---------- Saving ---------- */
function payload() {
  const c = P.church, d = P.d, groups = new Map();
  for (const i of d.items) { const k = sig(i); if (!groups.has(k)) groups.set(k, { ...i, days: [] }); groups.get(k).days.push(i.day); }
  const services = [...groups.values()].map(g => ({ kind: g.kind, days: [...new Set(g.days)].sort(), start: g.start, end: g.end || "", note: g.note, period: g.period, valid: g.valid,
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
  const st = $("#savestate"), pr = problems();
  if (pr) { st.textContent = pr[0]; st.className = "state dirty"; if (P.tab !== pr[1]) { P.tab = pr[1]; renderChurch(); } return; }
  $("#save").disabled = true; st.textContent = "Mentés…"; st.className = "state";
  const { error } = await sb.rpc("save_church", { p: payload() });
  if (error) { st.textContent = "Nem sikerült menteni: " + error.message; st.className = "state dirty"; $("#save").disabled = false; return; }
  P.savedAt = new Date().toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" });
  P.dirty = false; const tab = P.tab; await openChurch(P.church.id); P.tab = tab;
});
