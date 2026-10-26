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
const KINDS = { mass: "Mise", confession: "Gyóntatás", adoration: "Szentségimádás" };
const TYPES = { conf: "Gyóntatási időpont", mass: "Mise időpont", hours: "Nyitvatartás", event: "Esemény", place: "Hely vagy egyéb" };
const hm = t => t ? String(t).slice(0, 5) : "";

if (!real(CFG.supabaseUrl) || !real(CFG.supabaseAnonKey) || !window.supabase) {
  main.innerHTML = `<div class="card-box login"><h2>Még nincs beállítva</h2><p>Az adatbázis (Supabase) adatai hiányoznak a <code>config.js</code> fájlból. Add meg a <code>SUPABASE_URL</code> és <code>SUPABASE_PUBLISHABLE_KEY</code> titkokat a GitHub-tárolóban, majd futtasd újra a közzétételt. Lépések: README.</p></div>`;
  throw new Error("not configured");
}
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
const A = { user: null, staff: null, myChurches: null, tab: "churches", q: "", onlyEmpty: false, list: [], sel: null, draft: null, suggStatus: "pending" };

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
async function loadList() {
  let q = sb.from("churches").select("id,name,city,published,services(count)").order("name").limit(80);
  const term = A.q.trim().replace(/[%,()]/g, " ");
  if (term) q = q.or(`name.ilike.%${term}%,city.ilike.%${term}%`);
  if (A.myChurches) q = q.in("id", A.myChurches.length ? A.myChurches : [-1]);
  const { data, error } = await q;
  if (error) { $("#clist").innerHTML = `<li class="msg err">Nem sikerült betölteni: ${esc(error.message)}</li>`; return; }
  A.list = (data || []).map(c => ({ ...c, n: c.services?.[0]?.count ?? 0 })).filter(c => !A.onlyEmpty || c.n === 0);
  $("#clist").innerHTML = A.list.map(c => `<li><button data-id="${c.id}" aria-current="${A.sel === c.id}"><span class="nm">${esc(c.name)}</span>
    <span class="sub"><span>${esc(c.city || "–")}</span><span>${c.n ? c.n + " időpont" : "nincs időpont"}</span>${c.published ? "" : "<span>rejtett</span>"}</span></button></li>`).join("")
    || `<li class="muted" style="padding:8px">Nincs találat.</li>`;
  $("#clist").querySelectorAll("button").forEach(b => b.addEventListener("click", () => openChurch(+b.dataset.id)));
}
function renderChurches() {
  const isAdmin = A.staff.role === "admin";
  main.innerHTML = `<div class="split">
    <aside class="side">
      <label class="search" for="cq"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="cq" type="search" placeholder="Név vagy település" value="${esc(A.q)}" autocomplete="off"></label>
      <div class="row"><label class="check" for="only-empty"><input type="checkbox" id="only-empty" ${A.onlyEmpty ? "checked" : ""}>Csak időpont nélküliek</label>
        ${isAdmin ? `<button class="btn" id="new-church" style="margin-left:auto">Új templom</button>` : ""}</div>
      <ul class="clist" id="clist"><li class="muted" style="padding:8px">Betöltés…</li></ul>
      <p class="muted" style="margin:0;font-size:.78rem">Legfeljebb 80 találat látszik; keress névre vagy településre.</p>
    </aside>
    <section id="editor"><div class="card-box"><p class="muted" style="margin:0">Válassz templomot a listából${isAdmin ? ", vagy vegyél fel újat" : ""}.</p></div></section>
  </div>`;
  let t; $("#cq").addEventListener("input", e => { A.q = e.target.value; clearTimeout(t); t = setTimeout(loadList, 250); });
  $("#only-empty").addEventListener("change", e => { A.onlyEmpty = e.target.checked; loadList(); });
  $("#new-church")?.addEventListener("click", () => { A.sel = null; A.draft = blankChurch(); renderEditor(); });
  loadList();
  if (A.draft) renderEditor();
}
const blankChurch = () => ({ id: null, name: "", city: "", address: "", rite: "rk", lat: "", lon: "", website: "", phone: "", notes: "", open_only_services: false, published: true, hours: [], services: [], events: [] });
async function openChurch(id) {
  if (A.dirty && !confirmDiscard()) return;
  A.sel = id;
  $("#clist")?.querySelectorAll("button").forEach(b => b.setAttribute("aria-current", +b.dataset.id === id));
  $("#editor").innerHTML = `<div class="card-box"><p class="muted" style="margin:0">Betöltés…</p></div>`;
  const { data, error } = await sb.from("churches").select("*, opening_hours(*), services(*), events(*)").eq("id", id).single();
  if (error) { $("#editor").innerHTML = `<div class="card-box msg err">Nem sikerült megnyitni: ${esc(error.message)}</div>`; return; }
  A.draft = { ...data,
    hours: data.opening_hours.map(h => ({ days: h.days, opens: hm(h.opens), closes: hm(h.closes) })),
    services: data.services.sort((a, b) => a.kind.localeCompare(b.kind) || String(a.start_time).localeCompare(String(b.start_time)))
      .map(s => ({ kind: s.kind, days: s.days, start: hm(s.start_time), end: hm(s.end_time), note: s.note || "" })),
    events: data.events.sort((a, b) => String(a.date).localeCompare(String(b.date))).map(e => ({ date: e.date, start: hm(e.start_time), title: e.title, note: e.note || "" })) };
  A.dirty = false;
  renderEditor();
}
// The viewer's confirm() works on this normal web page (it is not inside a Claude artifact).
function confirmDiscard() { return window.confirm("Van mentetlen módosításod ennél a templomnál. Eldobod?"); }

function daysHTML(days, path) {
  return `<div class="days" role="group" aria-label="Napok">${DAY_ORDER.map(d => `<button type="button" data-days="${path}" data-d="${d}" aria-pressed="${days.includes(d)}">${DAY_SHORT[d]}</button>`).join("")}</div>`;
}
function renderEditor() {
  const c = A.draft, isAdmin = A.staff.role === "admin";
  const osm = c.lat && c.lon ? `https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lon}#map=18/${c.lat}/${c.lon}` : "";
  $("#editor").innerHTML = `<form class="card-box editor" id="ed" novalidate>
    <div><h2>${c.id ? esc(c.name) : "Új templom"}</h2>${c.id ? `<span class="muted" style="font-size:.8rem">Azonosító: ${c.id}</span>` : ""}</div>
    <div class="block"><h3>Alapadatok</h3>
      <div class="grid2">
        <label class="field" for="f-name">Név<input id="f-name" data-k="name" value="${esc(c.name)}" required></label>
        <label class="field" for="f-city">Település<input id="f-city" data-k="city" value="${esc(c.city)}"></label>
        <label class="field" for="f-address">Cím<input id="f-address" data-k="address" value="${esc(c.address)}"></label>
        <label class="field" for="f-rite">Rítus<select id="f-rite" data-k="rite"><option value="rk" ${c.rite === "rk" ? "selected" : ""}>római katolikus</option><option value="gk" ${c.rite === "gk" ? "selected" : ""}>görögkatolikus</option></select></label>
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
    </div>

    <div class="block"><h3>Nyitvatartás</h3>
      <label class="check" for="f-only"><input type="checkbox" id="f-only" data-k="open_only_services" ${c.open_only_services ? "checked" : ""}>Csak a szertartások idején van nyitva</label>
      <div class="rows">${c.hours.map((h, i) => `<div class="srow">${daysHTML(h.days, "hours." + i)}
        <label class="field" for="h-o-${i}">Nyit<input type="time" id="h-o-${i}" data-l="hours" data-i="${i}" data-f="opens" value="${esc(h.opens)}"></label>
        <label class="field" for="h-c-${i}">Zár<input type="time" id="h-c-${i}" data-l="hours" data-i="${i}" data-f="closes" value="${esc(h.closes)}"></label>
        <button type="button" class="icon-btn" data-del="hours" data-i="${i}" aria-label="Sor törlése">Törlés</button></div>`).join("")}</div>
      <div><button type="button" class="btn" data-add="hours">+ Nyitvatartási sor</button></div>
    </div>

    <div class="block"><h3>Rendszeres alkalmak</h3>
      <div class="rows">${c.services.map((s, i) => `<div class="srow">
        <label class="field" for="s-k-${i}">Fajta<select id="s-k-${i}" data-l="services" data-i="${i}" data-f="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${s.kind === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        ${daysHTML(s.days, "services." + i)}
        <label class="field" for="s-s-${i}">Kezdés<input type="time" id="s-s-${i}" data-l="services" data-i="${i}" data-f="start" value="${esc(s.start)}"></label>
        <label class="field" for="s-e-${i}">Vége${s.kind === "mass" ? " (nem kötelező)" : ""}<input type="time" id="s-e-${i}" data-l="services" data-i="${i}" data-f="end" value="${esc(s.end)}"></label>
        <label class="field note" for="s-n-${i}">Megjegyzés<input id="s-n-${i}" data-l="services" data-i="${i}" data-f="note" value="${esc(s.note)}" placeholder="pl. latin nyelvű, diákmise"></label>
        <button type="button" class="icon-btn" data-del="services" data-i="${i}" aria-label="Sor törlése">Törlés</button></div>`).join("")}</div>
      <div class="row"><button type="button" class="btn" data-add="services" data-kind="mass">+ Mise</button><button type="button" class="btn" data-add="services" data-kind="confession">+ Gyóntatás</button><button type="button" class="btn" data-add="services" data-kind="adoration">+ Szentségimádás</button></div>
    </div>

    <div class="block"><h3>Események</h3>
      <div class="rows">${c.events.map((e, i) => `<div class="srow">
        <label class="field" for="e-d-${i}">Dátum<input type="date" id="e-d-${i}" data-l="events" data-i="${i}" data-f="date" value="${esc(e.date)}"></label>
        <label class="field" for="e-s-${i}">Időpont<input type="time" id="e-s-${i}" data-l="events" data-i="${i}" data-f="start" value="${esc(e.start)}"></label>
        <label class="field note" for="e-t-${i}">Cím<input id="e-t-${i}" data-l="events" data-i="${i}" data-f="title" value="${esc(e.title)}" placeholder="pl. Búcsúi szentmise"></label>
        <label class="field note" for="e-n-${i}">Megjegyzés<input id="e-n-${i}" data-l="events" data-i="${i}" data-f="note" value="${esc(e.note)}"></label>
        <button type="button" class="icon-btn" data-del="events" data-i="${i}" aria-label="Sor törlése">Törlés</button></div>`).join("")}</div>
      <div><button type="button" class="btn" data-add="events">+ Esemény</button></div>
    </div>

    <div class="bar">
      <button class="btn primary" type="submit" id="save">Mentés</button>
      ${c.id && isAdmin ? `<button type="button" class="btn danger" id="del">Templom törlése</button>` : ""}
      <span class="msg" id="emsg" role="status"></span>
    </div>
  </form>`;
  bindEditor();
}
function bindEditor() {
  const c = A.draft, f = $("#ed");
  f.addEventListener("input", e => {
    const el = e.target; A.dirty = true;
    if (el.dataset.k) c[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value;
    else if (el.dataset.l) c[el.dataset.l][+el.dataset.i][el.dataset.f] = el.value;
  });
  f.addEventListener("change", e => { if (e.target.dataset.l === "services" && e.target.dataset.f === "kind") renderEditor(); });
  f.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.days) { const [list, i] = b.dataset.days.split("."), d = +b.dataset.d, row = c[list][+i];
      row.days = row.days.includes(d) ? row.days.filter(x => x !== d) : [...row.days, d].sort((a, z) => a - z);
      b.setAttribute("aria-pressed", row.days.includes(d)); A.dirty = true; }
    else if (b.dataset.add) { A.dirty = true;
      if (b.dataset.add === "hours") c.hours.push({ days: [1, 2, 3, 4, 5, 6, 0], opens: "08:00", closes: "18:00" });
      if (b.dataset.add === "services") c.services.push({ kind: b.dataset.kind, days: [0], start: "", end: "", note: "" });
      if (b.dataset.add === "events") c.events.push({ date: "", start: "", title: "", note: "" });
      renderEditor(); }
    else if (b.dataset.del) { A.dirty = true; c[b.dataset.del].splice(+b.dataset.i, 1); renderEditor(); }
  });
  f.addEventListener("submit", e => { e.preventDefault(); save(); });
  $("#del")?.addEventListener("click", delChurch);
}
function validate(c) {
  if (!c.name.trim()) return "Add meg a templom nevét.";
  const lat = parseFloat(String(c.lat).replace(",", ".")), lon = parseFloat(String(c.lon).replace(",", "."));
  if (!(lat >= 45 && lat <= 49) || !(lon >= 16 && lon <= 23.5)) return "A koordináták nem Magyarország területére esnek. Ellenőrizd a szélességet és a hosszúságot.";
  for (const [i, h] of c.hours.entries()) {
    if (!h.days.length) return `Nyitvatartás, ${i + 1}. sor: jelölj ki legalább egy napot.`;
    if (!h.opens || !h.closes || h.opens >= h.closes) return `Nyitvatartás, ${i + 1}. sor: a nyitás legyen a zárás előtt.`;
  }
  for (const [i, s] of c.services.entries()) {
    if (!s.days.length) return `Alkalmak, ${i + 1}. sor: jelölj ki legalább egy napot.`;
    if (!s.start) return `Alkalmak, ${i + 1}. sor: add meg a kezdés idejét.`;
    if (s.end && s.end <= s.start) return `Alkalmak, ${i + 1}. sor: a vége legyen a kezdés után.`;
  }
  for (const [i, e] of c.events.entries()) {
    if (!e.date || !e.title.trim()) return `Események, ${i + 1}. sor: a dátum és a cím kötelező.`;
  }
  return "";
}
async function save() {
  const c = A.draft, m = $("#emsg");
  const err = validate(c); if (err) { m.textContent = err; m.className = "msg err"; return; }
  $("#save").disabled = true; m.textContent = "Mentés…"; m.className = "msg";
  const p = { id: c.id, name: c.name.trim(), city: c.city.trim(), address: (c.address || "").trim(), rite: c.rite,
    lat: parseFloat(String(c.lat).replace(",", ".")), lon: parseFloat(String(c.lon).replace(",", ".")),
    website: c.website || "", phone: c.phone || "", notes: c.notes || "", open_only_services: !!c.open_only_services, published: !!c.published,
    hours: c.hours, services: c.services.map(s => ({ ...s, end: s.end || "" })), events: c.events };
  const { data, error } = await sb.rpc("save_church", { p });
  $("#save").disabled = false;
  if (error) { m.textContent = "Nem sikerült menteni: " + error.message; m.className = "msg err"; return; }
  A.dirty = false;
  m.textContent = "Mentve. A nyilvános oldalon frissítés után látszik."; m.className = "msg ok";
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
