"use strict";
/* Harangszó shared schedule editor: the week board (one row per day, a tile per time) and the question-style time
   editor in a bottom sheet. Used by the parish portal and, with admin: true, by the admin page. It edits only the
   regular rules it is given and hands them back through onChange; saving stays in each page (save_church).
   Rule = { kind, days[] (0 = Sunday), start, end, note, period, valid, weeks[], every, anchor, tags[], celebrant,
            place, place_church_id (number | ""), feast_skip } — the shape admin.js keeps in A.draft.services. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.ScheduleEditor = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  // calendar.js (window.LitCal) is loaded before this script in the browser; under Node it is required next to it.
  const LC = () => {
    if (!root.LitCal && typeof require === "function") { try { require("./calendar.js"); } catch (_) { } }
    return root.LitCal || globalThis.LitCal;
  };

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
  const hm = t => t ? String(t).slice(0, 5) : "";
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  const KINDS = [["mass", "Mise"], ["confession", "Gyóntatás"], ["adoration", "Szentségimádás"], ["prayer", "Imaóra"], ["rorate", "Rorate"]];
  const KIND_WORD = { mass: "mise", confession: "gyóntatás", adoration: "szentségimádás", prayer: "imaóra", rorate: "rorate" };
  const TILE_WORD = { mass: "mise", confession: "gyónás", adoration: "szentségimádás", prayer: "imaóra", rorate: "rorate" };
  const KORDER = { mass: 0, rorate: 1, confession: 2, adoration: 3, prayer: 4 };
  const DAY_NAME = ["Vasárnap", "Hétfő", "Kedd", "Szerda", "Csütörtök", "Péntek", "Szombat"];
  const DAY_SHORT = ["V", "H", "K", "Sze", "Cs", "P", "Szo"];
  const DAY_ON = ["vasárnap", "hétfőn", "kedden", "szerdán", "csütörtökön", "pénteken", "szombaton"];
  const DAY_FROM = ["vasárnaptól", "hétfőtől", "keddtől", "szerdától", "csütörtöktől", "péntektől", "szombattól"];
  const DAY_TO = ["vasárnapig", "hétfőig", "keddig", "szerdáig", "csütörtökig", "péntekig", "szombatig"];
  const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];   // picking days
  const BOARD_DAYS = [0, 1, 2, 3, 4, 5, 6];  // the board: Sunday first
  const MON = ["jan.", "febr.", "márc.", "ápr.", "máj.", "jún.", "júl.", "aug.", "szept.", "okt.", "nov.", "dec."];
  const ORD = { 1: "első", 2: "második", 3: "harmadik", 4: "negyedik", 5: "ötödik", "-1": "utolsó" };
  const WEEK_NS = [1, 2, 3, 4, 5, -1];
  const EVERY_WORD = { 2: "kéthetente", 3: "háromhetente", 4: "négyhetente" };
  const EVERY_OPT = { 2: "Kéthetente", 3: "Háromhetente", 4: "Négyhetente" };
  // Tags editors can set (calendar.js TAGS, the order both old editors used); languages through their own list.
  const TAG_ORDER = ["solemn", "family", "student", "youth", "university", "guitar", "organ", "choir", "silent", "vigil", "traditional", "word", "confession", "irregular"];
  const PERIOD_ORDER = ["all", "summer_months", "winter_months", "autumn", "spring", "summer", "winter", "school", "holiday", "advent", "christmas", "lent", "eastertide"];
  const PERIOD_HINT = { summer: "márciusi óraátállítástól októberiig", winter: "októberi óraátállítástól márciusiig", advent: "advent első vasárnapjától dec. 24-ig",
    christmas: "dec. 25. – Urunk megkeresztelkedése", lent: "hamvazószerdától nagyszombatig", eastertide: "húsvéttól pünkösdig" };
  const PERIOD_SHORT = { summer_months: "nyáron", winter_months: "télen", autumn: "ősszel", spring: "tavasszal", summer: "nyári időszámítás", winter: "téli időszámítás",
    school: "tanévben", holiday: "nyári szünetben", advent: "adventben", christmas: "karácsonykor", lent: "nagyböjtben", eastertide: "húsvéti időben" };

  /* ---------- Rules ⇄ day items ---------- */
  const uniqDays = days => [...new Set((days || []).filter(d => d !== null && d !== "" && d !== undefined).map(Number))].sort((a, b) => a - b);
  const pcid = v => v === "" || v == null || !Number.isFinite(+v) || +v === 0 ? "" : +v;
  // A rule with every field present and in its stored form (defaults as admin.js reads them from the database).
  function normalize(r) {
    r = r || {};
    return { kind: r.kind || "mass", days: uniqDays(r.days), start: hm(r.start ?? r.start_time), end: hm(r.end ?? r.end_time), note: r.note || "", period: r.period || "all",
      valid: r.valid || "", weeks: [...(r.weeks || [])], every: +r.every > 1 ? +r.every : 1, anchor: r.anchor || "", tags: [...(r.tags || [])],
      celebrant: r.celebrant || "", place: r.place || "", place_church_id: pcid(r.place_church_id), feast_skip: !!r.feast_skip };
  }
  // Every field but the day: items with equal signatures belong to one rule.
  const sig = it => JSON.stringify([it.kind, it.start, it.end, it.note, it.period, it.valid, it.weeks || [], +it.every > 1 ? +it.every : 1, it.anchor, [...(it.tags || [])].sort(),
    it.celebrant, it.place, pcid(it.place_church_id), !!it.feast_skip]);
  let uidN = 0;
  const uid = () => "se" + (++uidN);
  // One item per (rule, day). A rule without days keeps one day-less item so join() gives it back.
  function split(rules) {
    const out = [];
    for (const r of rules || []) {
      const { days, ...rest } = normalize(r);
      for (const day of days.length ? days : [null]) out.push({ uid: uid(), day, ...rest, weeks: [...rest.weeks], tags: [...rest.tags] });
    }
    return out;
  }
  // Items with equal fields except the day become one rule again, in order of first appearance, days sorted.
  function join(items) {
    const groups = new Map();
    for (const i of items || []) {
      const k = sig(i);
      if (!groups.has(k)) groups.set(k, { item: i, days: [] });
      if (i.day !== null && i.day !== undefined) groups.get(k).days.push(i.day);
    }
    return [...groups.values()].map(({ item, days }) => {
      const { uid: _u, day: _d, ...rest } = item;
      const n = normalize({ ...rest, days });
      return { kind: n.kind, days: n.days, start: n.start, end: n.end, note: n.note, period: n.period, valid: n.valid, weeks: n.weeks, every: n.every, anchor: n.anchor,
        tags: n.tags, celebrant: n.celebrant, place: n.place, place_church_id: n.place_church_id, feast_skip: n.feast_skip };
    });
  }
  // What the editor stores for a rule: Mass and Rorate have no end; Rorate is always "all year" (shown only in Advent)
  // and never skipped on feasts; tags only for Mass and Rorate; an anchor only for every 2+ weeks.
  function finish(f) {
    const n = normalize(f), mass = n.kind === "mass" || n.kind === "rorate", ror = n.kind === "rorate";
    return { kind: n.kind, days: n.days, start: n.start, end: mass ? "" : n.end, note: n.note.trim(), period: ror ? "all" : n.period, valid: ror ? "" : n.valid,
      weeks: n.weeks, every: n.every, anchor: n.every > 1 ? n.anchor : "", tags: mass ? n.tags : [], celebrant: n.celebrant.trim(), place: n.place.trim(),
      place_church_id: n.place_church_id, feast_skip: !ror && n.feast_skip };
  }

  /* ---------- Parsing typed values ---------- */
  // 24-hour times typed freely: 1730, 17.30, 17,30, 9:5, 17 → 17:30, 09:05, 17:00 (as admin.js accepts them).
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
  const md = (m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31 ? String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0") : null;
  // A month-day typed as 06-15, 6.15., 06/15 or 0615 → "06-15"; "" when empty; null when not a date.
  function normMD(v) {
    v = String(v || "").trim();
    if (!v) return "";
    let m = v.match(/^(\d{1,2})\s*[.\-/ ]\s*(\d{1,2})\.?$/);
    if (!m && /^\d{4}$/.test(v)) m = [null, v.slice(0, 2), v.slice(2)];
    return m ? md(+m[1], +m[2]) : null;
  }
  // `valid` typed raw: "06-01/08-31,10-01/10-31" (or 06.01–08.31 as the old admin form showed it) → canonical, "" or null.
  function parseValid(t) {
    t = String(t || "").trim();
    if (!t) return "";
    const out = [];
    for (const part of t.split(/[,;]+/).map(x => x.trim()).filter(Boolean)) {
      const m = part.match(/^(\d{1,2})-(\d{1,2})\s*\/\s*(\d{1,2})-(\d{1,2})$/) || part.match(/^(\d{1,2})[.\-/](\d{1,2})\.?\s*[–—-]\s*(\d{1,2})[.\-/](\d{1,2})\.?$/);
      if (!m) return null;
      const a = md(+m[1], +m[2]), b = md(+m[3], +m[4]);
      if (!a || !b) return null;
      out.push(a + "/" + b);
    }
    return out.join(",");
  }
  // weeks typed raw: "1, 3, -1" (or "utolsó") → [1, 3, -1]; null when something else is in it.
  function parseWeeks(t) {
    const out = [];
    for (const x of String(t || "").split(/[,;\s]+/).filter(Boolean)) {
      const n = /^utols/i.test(x) ? -1 : Number(x.replace(/\.$/, ""));
      if (!WEEK_NS.includes(n)) return null;
      if (!out.includes(n)) out.push(n);
    }
    return out.sort((a, b) => (a < 0) - (b < 0) || a - b);
  }

  /* ---------- The rule in words ---------- */
  const list = xs => xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " és " + xs[xs.length - 1];
  function daysText(days) {
    const ds = MON_FIRST.filter(d => (days || []).map(Number).includes(d));
    if (!ds.length) return "";
    if (ds.length === 7) return "minden nap";
    const is = (...want) => ds.length === want.length && want.every((d, i) => ds[i] === d);
    if (is(1, 2, 3, 4, 5)) return "hétköznap (hétfőtől péntekig)";
    if (is(6, 0)) return "hétvégén (szombaton és vasárnap)";
    const idx = ds.map(d => MON_FIRST.indexOf(d));
    if (ds.length >= 3 && idx.every((x, i) => x === idx[0] + i)) return DAY_FROM[ds[0]] + " " + DAY_TO[ds[ds.length - 1]];
    return list(ds.map(d => DAY_ON[d]));
  }
  const timeText = r => !TIME_RE.test(r.start || "") ? "" : TIME_RE.test(r.end || "") ? `${r.start}–${r.end}` : `${r.start}-kor`;
  function kindText(r) {
    const tags = (r.kind === "mass" || r.kind === "rorate" ? r.tags || [] : []).map(t => LC().tagLabel(t));
    if (r.kind === "rorate") tags.unshift("adventi hajnali mise");
    const base = r.kind === "prayer" ? (r.note || "").trim() || KIND_WORD.prayer : KIND_WORD[r.kind] || r.kind;
    return tags.length ? `${base} (${tags.join(", ")})` : base;
  }
  function freqText(r) {
    const every = +r.every > 1 ? +r.every : 1, weeks = r.weeks || [];
    const e = every > 1 ? EVERY_WORD[every] || every + " hetente" : "";
    const w = weeks.length ? "a hónap " + list(weeks.map(n => ORD[n] || n)) + " hetében" : "";
    return [e, w].filter(Boolean).join(", ") || "minden héten";
  }
  const rangeText = v => String(v || "").split(",").filter(Boolean).map(r => r.split("/").map(x => {
    const [m, d] = x.split("-").map(Number); return MON[m - 1] ? `${MON[m - 1]} ${d}.` : x;
  }).join("–")).join(" és ");
  function periodText(r) {
    if (r.kind === "rorate") return "";
    const p = r.period || "all", name = LC().PERIOD_INFO[p]?.name || p;
    if (r.valid) return p === "all" ? `${rangeText(r.valid)} között` : `${name} (${rangeText(r.valid)})`;
    return name;
  }
  function placeText(r, ctx) {
    const id = pcid(r.place_church_id), other = id ? (ctx?.nearby || []).find(n => +n.id === id) : null;
    const names = [(r.place || "").trim(), id ? other ? other.name : "másik templomban" : ""].filter(Boolean);
    return names.length ? "helyszín: " + names.join(", ") : "";
  }
  function celebrantText(r) {
    const c = (r.celebrant || "").trim();
    if (!c) return "";
    return (r.kind === "confession" ? "gyóntat: " : r.kind === "mass" || r.kind === "rorate" ? "bemutatja: " : "vezeti: ") + c;
  }
  // The one-sentence Hungarian summary shown under the questions (and as the tile's title).
  function describe(rule, ctx) {
    const r = { ...rule, weeks: rule?.weeks || [], tags: rule?.tags || [] };
    const lead = [daysText(r.days), timeText(r), kindText(r)].filter(Boolean).join(" ");
    const note = r.kind !== "prayer" && (r.note || "").trim() ? "megjegyzés: " + r.note.trim() : "";
    const parts = [lead, freqText(r), periodText(r), r.feast_skip && r.kind !== "rorate" ? "ünnepnapokon elmarad" : "", placeText(r, ctx), celebrantText(r), note];
    return cap(parts.filter(Boolean).join(", ")) + ".";
  }
  // The short line on a tile: kind word, then season, frequency, language, note, tags (the tile cuts it with an ellipsis).
  function tileText(r) {
    const C = LC(), tags = r.kind === "mass" || r.kind === "rorate" ? r.tags || [] : [];
    const lang = tags.find(t => t.startsWith("lang:"));
    const weeks = r.weeks || [];
    return [r.kind === "prayer" ? (r.note || "").trim() || TILE_WORD.prayer : TILE_WORD[r.kind] || r.kind,
      r.kind === "rorate" ? "" : r.valid ? "saját időszak" : PERIOD_SHORT[r.period] || "",
      +r.every > 1 ? EVERY_WORD[r.every] || r.every + " hetente" : weeks.length ? weeks.map(n => n === -1 ? "utolsó" : n + ".").join(", ") + " hét" : "",
      lang ? C.LANGS[lang.slice(5)] || lang.slice(5) : "",
      r.kind !== "prayer" ? (r.note || "").trim() : "",
      ...tags.filter(t => !t.startsWith("lang:")).map(t => C.tagLabel(t))].filter(Boolean).join(" · ");
  }

  /* ---------- Dates for "every N weeks" ---------- */
  const todayDate = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
  const fromYmd = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const mondayOf = date => LC().addDays(date, -((date.getDay() + 6) % 7));
  // Default anchor: the Monday of the week of the next occurrence (first chosen day), as the parish portal did.
  // A Monday anchor makes every day of that Monday–Sunday week count as an "on" week (LitCal.everyOk).
  function defaultAnchor(days) {
    const C = LC(), first = MON_FIRST.find(d => (days || []).includes(d)) ?? 0;
    return C.ymd(mondayOf(C.nextDate(todayDate(), x => x.getDay() === first)));
  }

  /* ---------- Board + sheet ---------- */
  let mountN = 0;
  function mount(el, opts) {
    opts = opts || {};
    const doc = el.ownerDocument, C = LC(), P = "se" + (++mountN) + "-";
    const admin = !!opts.admin, nearby = opts.nearby || [], onChange = typeof opts.onChange === "function" ? opts.onChange : () => { };
    let items = split(opts.rules || []), E = null;
    const ctx = { nearby };

    const dlg = doc.createElement("dialog");
    dlg.className = "ui-sheet se-sheet";
    dlg.setAttribute("aria-labelledby", P + "title");
    doc.body.append(dlg);

    const byTime = (a, b) => String(a.start).localeCompare(String(b.start)) || (KORDER[a.kind] ?? 9) - (KORDER[b.kind] ?? 9);
    function renderBoard() {
      const daysOf = new Map();
      for (const i of items) { const k = sig(i); if (!daysOf.has(k)) daysOf.set(k, []); if (i.day !== null) daysOf.get(k).push(i.day); }
      el.innerHTML = `<div class="se-board">${BOARD_DAYS.map(d => {
        const list = items.filter(i => i.day === d).sort(byTime);
        return `<div class="se-day${d === 0 ? " sun" : ""}" role="group" aria-labelledby="${P}d${d}">
          <h3 class="se-dh"><span id="${P}d${d}">${DAY_NAME[d]}</span>${list.length ? `<small>${list.length} alkalom</small>` : ""}</h3>
          <div class="se-tiles">${list.map(i => `<button type="button" class="se-tile k-${esc(i.kind)}" data-uid="${i.uid}" title="${esc(describe({ ...i, days: daysOf.get(sig(i)) }, ctx))}"><b>${esc(i.start)}</b><span>${esc(tileText(i))}</span></button>`).join("")}<button type="button" class="se-tile se-add" data-add="${d}" aria-label="Időpont hozzáadása: ${DAY_NAME[d]}">＋</button></div>
        </div>`;
      }).join("")}</div>`;
    }
    const onBoardClick = e => {
      const t = e.target.closest?.("[data-uid],[data-add]");
      if (!t || !el.contains(t)) return;
      if (t.dataset.uid) { const it = items.find(i => i.uid === t.dataset.uid); if (it) open(it, null, t); }
      else open(null, +t.dataset.add, t);
    };
    el.addEventListener("click", onBoardClick);

    /* The sheet is drawn once per opening; every later change updates it in place (sync), so a field's change event
       never replaces the button the user is about to click, and the plain and the Haladó views always agree. */
    const periodSel = () => E.ui.custom || (E.f.valid && E.f.period === "all") ? "custom" : E.f.period;
    const hasDetails = f => !!(f.celebrant || f.place || f.place_church_id || (f.tags || []).length || (f.kind !== "prayer" && f.note) || f.period !== "all" || f.valid || f.feast_skip);
    const deriveFreq = f => +f.every > 1 ? "every" : (f.weeks || []).length ? "weeks" : "weekly";
    function open(item, day, opener) {
      let f, uids = [];
      if (item) {
        const s = sig(item), group = items.filter(i => sig(i) === s);
        uids = group.map(i => i.uid);
        f = normalize({ ...item, days: group.map(i => i.day) });
      } else f = normalize({ kind: "mass", days: [day], start: "", period: "all" });
      E = { mode: item ? "edit" : "add", uids, f, opener, origKind: f.kind,
        ui: { freq: deriveFreq(f), custom: !!f.valid && f.period === "all", buf: {}, bad: {}, err: null, confirmDel: false } };
      drawSheet();
      sync();
      dlg.showModal();
      const first = E.mode === "add" ? dlg.querySelector(".se-start") : dlg.querySelector(`#${P}title`);
      first?.focus({ preventScroll: true });
    }

    const chip = (attr, v, label, extra = "") => `<button type="button" class="ui-chip" ${attr}="${esc(v)}" aria-pressed="false"${extra}>${esc(label)}</button>`;
    const PERIOD_LABEL = k => {
      const p = C.PERIOD_INFO[k], name = cap(p?.name || k);
      const hint = PERIOD_HINT[k] || (p?.range ? rangeText(p.range) : "");
      return name.includes("(") || !hint ? name : `${name} (${hint})`;
    };
    function drawSheet() {
      const f = E.f, kinds = KINDS.filter(([k]) => k !== "rorate" || admin || E.origKind === "rorate");
      const periods = [...PERIOD_ORDER, ...(PERIOD_ORDER.includes(f.period) ? [] : [f.period])];
      const near = [...nearby];
      if (f.place_church_id && !near.some(n => +n.id === f.place_church_id)) near.push({ id: f.place_church_id, name: "#" + f.place_church_id });
      const langs = Object.entries(C.LANGS).filter(([k]) => k !== "hu");
      const txt = () => `autocomplete="off" spellcheck="false"`;
      dlg.innerHTML = `<header><h2 id="${P}title" tabindex="-1">${E.mode === "add" ? "Új időpont" : "Időpont módosítása"}</h2><button type="button" class="ui-btn quiet" data-act="cancel">Mégse</button></header>
      <div class="body">
        <div class="se-q" role="group" aria-labelledby="${P}q-kind"><p class="se-ql" id="${P}q-kind">Mi lesz?</p>
          <div class="se-pills">${kinds.map(([k, v]) => chip("data-kind", k, v)).join("")}</div>
          <label class="ui-field" data-show="prayer" data-errkey="name"><span>Megnevezés</span><input data-f="note" maxlength="200" placeholder="pl. Rózsafüzér, Vesperás, Keresztút" ${txt()}></label>
          <p class="se-hint" data-show="rorate">Csak adventben jelenik meg, magától.</p></div>
        <div class="se-q" role="group" aria-labelledby="${P}q-time"><p class="se-ql" id="${P}q-time">Hánykor?</p>
          <div class="se-time"><input class="se-start" data-f="start" data-errkey="start" aria-labelledby="${P}q-time" inputmode="numeric" maxlength="5" placeholder="ÓÓ:PP" ${txt()}>
            <span class="se-dash" data-show="end" aria-hidden="true">–</span>
            <label class="se-endf" data-show="end" data-errkey="end"><span>vége</span><input data-f="end" inputmode="numeric" maxlength="5" placeholder="–" ${txt()}></label></div></div>
        <div class="se-q" role="group" aria-labelledby="${P}q-days"><p class="se-ql" id="${P}q-days">Mely napokon?</p>
          <div class="ui-daypick" data-errkey="days">${MON_FIRST.map(d => `<button type="button" data-day="${d}" aria-pressed="false" aria-label="${DAY_NAME[d]}">${DAY_SHORT[d]}</button>`).join("")}</div></div>
        <div class="se-q" role="group" aria-labelledby="${P}q-freq"><p class="se-ql" id="${P}q-freq">Milyen gyakran?</p>
          <div class="se-pills">${chip("data-freq", "weekly", "Minden héten")}${chip("data-freq", "every", "Kéthetente")}${chip("data-freq", "weeks", "A hónap … hetében")}</div>
          <div class="se-grid2" data-show="every">
            <label class="ui-field"><span>Hány hetente?</span><select data-f="every"></select></label>
            <label class="ui-field" data-errkey="anchor"><span>Melyik héten lesz legközelebb?</span><input type="date" data-f="anchorWeek"><small>A hét hétfője; ettől számoljuk a többit.</small></label></div>
          <div class="se-weeks" data-show="weeks"><div class="se-pills" role="group" aria-label="A hónap hetei" data-errkey="weeks">${WEEK_NS.map(n => chip("data-wk", n, n === -1 ? "utolsó" : n + ".")).join("")}</div>
            <p class="se-hint">Pl. az „1.” a hónap első ilyen napja.</p></div></div>
        <p class="se-sum" data-text="sum" aria-live="polite"></p>
        <details class="ui-fold se-more"${hasDetails(f) ? " open" : ""}><summary>Időszak, nyelv, ki mutatja be, máshol tartják</summary><div class="se-fold">
          <div class="se-sub" data-show="period">
            <label class="ui-field"><span>Az év melyik részében?</span><select data-f="period">${periods.map(k => `<option value="${esc(k)}">${esc(PERIOD_LABEL(k))}</option>`).join("")}<option value="custom">Saját időszakban (megadod, mettől meddig)</option></select></label>
            <div class="se-grid2" data-show="range">
              <label class="ui-field" data-errkey="range"><span>Ettől (hó-nap)</span><input data-buf="rFrom" inputmode="numeric" placeholder="pl. 06-15" ${txt()}></label>
              <label class="ui-field" data-errkey="range"><span>Eddig (hó-nap)</span><input data-buf="rTo" inputmode="numeric" placeholder="pl. 08-31" ${txt()}></label>
              <p class="se-hint se-span" data-text="range-hint"></p></div></div>
          <div class="se-sub" data-show="tags"><p class="se-ql se-ql-s" id="${P}q-tags">Milyen mise?</p>
            <div class="se-pills" role="group" aria-labelledby="${P}q-tags">${TAG_ORDER.map(t => chip("data-tag", t, C.TAGS[t] || t)).join("")}</div>
            <label class="ui-field"><span>Nyelve</span><select data-f="lang"><option value="">magyar</option>${langs.map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("")}</select></label></div>
          <label class="ui-field"><span data-text="cel-label">Ki mutatja be?</span><input data-f="celebrant" maxlength="80" placeholder="pl. plébános atya, P. Kamill" ${txt()}><small>Nem kötelező.</small></label>
          <label class="ui-field" data-show="note"><span>Megjegyzés</span><input data-f="note" maxlength="200" placeholder="pl. utána szentségimádás" ${txt()}></label>
          ${near.length ? `<label class="ui-field"><span>Másik templomban tartják?</span><select data-f="place_church_id"><option value="">Nem, ebben a templomban (vagy a lenti helyszínen)</option>${near.map(n => `<option value="${+n.id}">${esc(n.name)}${n.city ? " – " + esc(n.city) : ""}</option>`).join("")}</select><small>A másik templom oldalán is megjelenik.</small></label>` : ""}
          <label class="ui-field"><span>Helyszín, ha nem a templomban</span><input data-f="place" maxlength="120" placeholder="pl. temetőkápolna, kórház, idősek otthona" ${txt()}></label>
          <label class="se-check" data-show="skip"><input type="checkbox" class="ui-toggle" data-f="feast_skip"><span>Ünnepnapokon elmarad<small>Parancsolt ünnepeken és munkaszüneti napokon, ha nem vasárnapra esnek. Az ünnepi rend külön adható meg.</small></span></label>
        </div></details>
        ${admin ? `<details class="ui-fold se-adv"><summary>Haladó</summary><div class="se-fold">
          <p class="se-hint">A szabály nyers mezői; ami itt változik, fent is látszik.</p>
          <label class="ui-field" data-show="raw-valid" data-errkey="raw-valid"><span>Érvényesség (valid)</span><input data-buf="valid" placeholder="pl. 06-01/08-31" ${txt()}><small>HH-NN/HH-NN, több időszak vesszővel. Üresen az időszak szerint.</small></label>
          <label class="ui-field" data-errkey="raw-weeks"><span>A hónap hetei (weeks)</span><input data-buf="weeks" placeholder="pl. 1,3 vagy -1" ${txt()}><small>1–5, a -1 az utolsó hét. Üresen minden héten.</small></label>
          <div class="se-grid2">
            <label class="ui-field" data-errkey="raw-every"><span>Hetente (every)</span><input data-buf="every" type="number" min="1" max="12" step="1" inputmode="numeric"><small>1 = minden héten, 2 = kéthetente</small></label>
            <label class="ui-field" data-errkey="raw-anchor"><span>Kezdő nap (anchor)</span><input type="date" data-f="anchor"><small>Ettől számoljuk a heteket.</small></label></div>
          <label class="se-check" data-show="skip"><input type="checkbox" class="ui-toggle" data-f="feast_skip"><span>Ünnepnapokon elmarad (feast_skip)</span></label>
        </div></details>` : ""}
      </div>
      <footer><p class="se-msg" role="alert" data-text="msg"></p>${E.mode === "edit" ? `<button type="button" class="ui-btn danger" data-act="del">Törlés</button>` : ""}<button type="button" class="ui-btn primary" data-act="save">${E.mode === "add" ? "Hozzáadás" : "Mentés"}</button></footer>`;
    }

    // The rule as it would be stored right now (unfinished times left out), for the live summary.
    const preview = () => finish({ ...E.f, start: TIME_RE.test(normTime(E.f.start)) ? normTime(E.f.start) : "", end: TIME_RE.test(normTime(E.f.end)) ? normTime(E.f.end) : "" });
    const syncSum = () => { const s = dlg.querySelector("[data-text=sum]"); if (s) s.textContent = describe(preview(), ctx); };
    function fieldValue(k) {
      const f = E.f;
      if (k === "period") return periodSel();
      if (k === "lang") return ((f.tags || []).find(t => t.startsWith("lang:")) || "").slice(5);
      if (k === "every") return String(+f.every > 1 ? +f.every : 2);
      if (k === "anchorWeek" || k === "anchor") return f.anchor || "";
      if (k === "place_church_id") return String(f.place_church_id || "");
      return f[k] ?? "";
    }
    function bufValue(k) {
      const f = E.f, b = E.ui.buf;
      if (b[k] != null) return b[k];
      const [a = "", z = ""] = (f.valid || "").split(",")[0].split("/");
      return { rFrom: a, rTo: z, valid: f.valid || "", weeks: (f.weeks || []).join(","), every: String(+f.every > 1 ? +f.every : 1) }[k] ?? "";
    }
    function sync() {
      const f = E.f, u = E.ui, ps = periodSel(), mass = f.kind === "mass" || f.kind === "rorate", ror = f.kind === "rorate";
      const active = doc.activeElement;
      const show = { prayer: f.kind === "prayer", rorate: ror, end: !mass, every: u.freq === "every", weeks: u.freq === "weeks", period: !ror,
        range: !ror && ps !== "all" && (ps === "custom" || !!f.valid || admin || u.buf.rFrom != null || u.buf.rTo != null),
        tags: mass, note: f.kind !== "prayer", skip: !ror, "raw-valid": !ror };
      dlg.querySelectorAll("[data-show]").forEach(x => { x.hidden = !show[x.dataset.show]; });
      const press = (sel, on) => dlg.querySelectorAll(sel).forEach(b => b.setAttribute("aria-pressed", String(on(b))));
      press("[data-kind]", b => b.dataset.kind === f.kind);
      press("[data-day]", b => f.days.includes(+b.dataset.day));
      press("[data-freq]", b => b.dataset.freq === u.freq);
      press("[data-wk]", b => (f.weeks || []).includes(+b.dataset.wk));
      press("[data-tag]", b => (f.tags || []).includes(b.dataset.tag));
      const ev = dlg.querySelector("select[data-f=every]");
      if (ev) {
        const want = [...new Set([2, 3, 4, +f.every > 1 ? +f.every : 2])].sort((a, b) => a - b);
        if (ev.options.length !== want.length) ev.innerHTML = want.map(n => `<option value="${n}">${EVERY_OPT[n] || n + " hetente"}</option>`).join("");
      }
      // Typed text stays as typed while its field has focus; everything else shows the state.
      const typing = x => x === active && (x.tagName === "TEXTAREA" || (x.tagName === "INPUT" && !["checkbox", "date"].includes(x.type)));
      dlg.querySelectorAll("[data-f]").forEach(x => {
        if (typing(x)) return;
        if (x.type === "checkbox") x.checked = !!f[x.dataset.f];
        else x.value = fieldValue(x.dataset.f);
      });
      dlg.querySelectorAll("[data-buf]").forEach(x => { if (!(typing(x) && u.buf[x.dataset.buf] != null)) x.value = bufValue(x.dataset.buf); });
      dlg.querySelectorAll("[data-errkey]").forEach(x => x.classList.toggle("err", u.err?.key === x.dataset.errkey || !!u.bad[x.dataset.errkey]));
      const p = C.PERIOD_INFO[ps], rest = (f.valid || "").split(",").filter(Boolean).slice(1);
      const texts = {
        "cel-label": f.kind === "confession" ? "Ki gyóntat?" : f.kind === "mass" || f.kind === "rorate" ? "Ki mutatja be?" : "Ki vezeti?",
        "range-hint": (ps === "custom" ? "Minden évben ugyanebben az időszakban érvényes." : `Üresen: ${PERIOD_HINT[ps] || (p?.range ? rangeText(p.range) : p?.name || "")}.`) +
          (rest.length ? ` További időszak: ${rangeText(rest.join(","))}.` : ""),
        msg: u.err?.msg || "",
      };
      dlg.querySelectorAll("[data-text]").forEach(x => { if (x.dataset.text in texts) x.textContent = texts[x.dataset.text]; });
      const del = dlg.querySelector("[data-act=del]");
      if (del) del.textContent = u.confirmDel ? "Biztosan törlöd?" : "Törlés";
      syncSum();
    }

    /* ---------- Interaction ---------- */
    const toggle = (arr, v) => arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v];
    function setFreq(x) {
      const f = E.f, u = E.ui;
      if (u.freq === x) return;
      if (x === "weekly") { f.every = 1; f.weeks = []; f.anchor = ""; }
      if (x === "every") { f.every = +f.every > 1 ? +f.every : 2; f.weeks = []; f.anchor ||= defaultAnchor(f.days); }
      if (x === "weeks") { f.every = 1; f.anchor = ""; }
      u.freq = x; delete u.buf.weeks; delete u.buf.every; delete u.bad["raw-weeks"]; delete u.bad["raw-every"];
    }
    function onClick(e) {
      if (!E) return;
      // A tap on the dimmed backdrop (outside the sheet's box) closes it, like Mégse.
      if (e.target === dlg) {
        const r = dlg.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return dlg.close();
      }
      const b = e.target.closest?.("button");
      if (!b || !dlg.contains(b)) return;
      const f = E.f, u = E.ui, d = b.dataset;
      if (d.act === "cancel") return dlg.close();
      if (d.act === "save") return submit();
      if (d.act === "del") {
        if (!u.confirmDel) { u.confirmDel = true; return sync(); }
        return remove();
      }
      if (d.kind) f.kind = d.kind;
      else if (d.day !== undefined) f.days = toggle(f.days, +d.day);
      else if (d.freq) setFreq(d.freq);
      else if (d.wk !== undefined) { f.weeks = toggle(f.weeks || [], +d.wk).sort((a, z) => (a < 0) - (z < 0) || a - z); delete u.buf.weeks; delete u.bad["raw-weeks"]; }
      else if (d.tag) f.tags = toggle(f.tags || [], d.tag);
      else return;
      u.err = null;
      sync();
    }
    function onInput(e) {
      if (!E) return;
      const x = e.target, k = x.dataset?.f;
      if (x.dataset?.buf) { E.ui.buf[x.dataset.buf] = x.value; return; }
      if (["start", "end", "note", "celebrant", "place"].includes(k)) {
        E.f[k] = x.value;
        if (k === "note") dlg.querySelectorAll("[data-f=note]").forEach(o => { if (o !== x) o.value = x.value; });
        syncSum();
      }
    }
    function onFieldChange(e) {
      if (!E) return;
      const x = e.target, f = E.f, u = E.ui, k = x.dataset?.f, bk = x.dataset?.buf;
      u.err = null;
      if (k === "start" || k === "end") { f[k] = normTime(x.value); x.value = f[k]; }
      else if (k === "period") {
        u.custom = x.value === "custom";
        f.period = u.custom ? "all" : x.value;
        // Own dates go with "Saját időszakban"; admin may also keep them on a named period (they override its dates).
        if (x.value === "all" || (!admin && !u.custom)) { f.valid = ""; delete u.buf.rFrom; delete u.buf.rTo; delete u.bad.range; }
      }
      else if (k === "lang") f.tags = [...(f.tags || []).filter(t => !t.startsWith("lang:")), ...(x.value ? ["lang:" + x.value] : [])];
      else if (k === "every") { f.every = +x.value; delete u.buf.every; }
      else if (k === "anchorWeek") { f.anchor = DATE_RE.test(x.value) ? C.ymd(mondayOf(fromYmd(x.value))) : ""; x.value = f.anchor; }
      else if (k === "anchor") { f.anchor = DATE_RE.test(x.value) ? x.value : ""; u.freq = deriveFreq(f); }
      else if (k === "place_church_id") f.place_church_id = pcid(x.value);
      else if (k === "feast_skip") f.feast_skip = x.checked;
      else if (bk === "rFrom" || bk === "rTo") {
        u.buf[bk] = x.value;
        const a = normMD(bufValue("rFrom")), z = normMD(bufValue("rTo")), rest = (f.valid || "").split(",").filter(Boolean).slice(1);
        u.bad.range = a === null || z === null;
        if (a === "" && z === "") { f.valid = rest.join(","); delete u.buf.rFrom; delete u.buf.rTo; }
        else if (a && z) { f.valid = [`${a}/${z}`, ...rest].join(","); delete u.buf.rFrom; delete u.buf.rTo; }
        delete u.bad["raw-valid"]; delete u.buf.valid;
      }
      else if (bk === "valid") {
        const v = parseValid(x.value);
        u.bad["raw-valid"] = v === null;
        if (v === null) u.buf.valid = x.value;
        else { f.valid = v; delete u.buf.valid; delete u.buf.rFrom; delete u.buf.rTo; delete u.bad.range; if (!v && f.period === "all") u.custom = false; }
      }
      else if (bk === "weeks") {
        const w = parseWeeks(x.value);
        u.bad["raw-weeks"] = w === null;
        if (w === null) u.buf.weeks = x.value;
        else { f.weeks = w; delete u.buf.weeks; u.freq = deriveFreq(f); }
      }
      else if (bk === "every") {
        const n = Number(x.value);
        const ok = Number.isInteger(n) && n >= 1 && n <= 12;
        u.bad["raw-every"] = !ok;
        if (!ok) u.buf.every = x.value;
        else { f.every = n; if (n > 1) f.anchor ||= defaultAnchor(f.days); delete u.buf.every; u.freq = deriveFreq(f); }
      }
      else return;
      sync();
    }
    function onKey(e) {
      if (e.key === "Enter" && e.target.tagName === "INPUT" && !["checkbox", "date"].includes(e.target.type)) { e.preventDefault(); e.target.dispatchEvent(new Event("change", { bubbles: true })); submit(); }
    }

    function check() {
      const f = E.f, u = E.ui, mass = f.kind === "mass" || f.kind === "rorate", ror = f.kind === "rorate";
      f.start = normTime(f.start); f.end = mass ? f.end : normTime(f.end);
      if (!TIME_RE.test(f.start)) return ["start", "Add meg, hánykor kezdődik, 24 órás formában (pl. 18:00)."];
      if (!mass && f.end && !TIME_RE.test(f.end)) return ["end", "A vége nem érvényes időpont. Írd így: 18:30, vagy hagyd üresen."];
      if (!mass && f.end && f.end <= f.start) return ["end", "A vége legyen később, mint a kezdés."];
      if (!f.days.length) return ["days", "Jelölj ki legalább egy napot."];
      if (f.kind === "prayer" && !(f.note || "").trim()) return ["name", "Írd be, milyen ájtatosság ez (pl. Rózsafüzér)."];
      if (u.freq === "every" || +f.every > 1) {
        if (!f.anchor) return ["anchor", "Add meg, melyik héten lesz legközelebb."];
        // Weeks are counted from the anchor (LitCal.everyOk): a Monday covers the whole week, any other day only
        // makes sense when it is one of the chosen days (the old admin check, loosened for Monday anchors).
        const wd = fromYmd(f.anchor).getDay();
        if (wd !== 1 && !f.days.includes(wd)) return admin ? ["raw-anchor", "A kezdő nap (anchor) hétfő legyen, vagy a kijelölt napok egyike."]
          : ["anchor", "Válaszd ki újra, melyik héten lesz legközelebb."];
      }
      if (u.freq === "weeks" && !(f.weeks || []).length) return ["weeks", "Jelöld ki, a hónap melyik hetében."];
      if (u.bad["raw-weeks"]) return ["raw-weeks", "A heteket így írd: 1,3 vagy -1 (utolsó)."];
      if (u.bad["raw-every"]) return ["raw-every", "A „Hetente” mezőbe 1 és 12 közötti egész számot írj."];
      if (!ror) {
        if (u.bad["raw-valid"]) return ["raw-valid", "Az időszakot így írd: 06-01/08-31 (több időszak vesszővel)."];
        if (u.bad.range || u.buf.rFrom != null || u.buf.rTo != null) return ["range", "Add meg az időszak elejét és végét is, így: 06-15 és 08-31."];
        if (periodSel() === "custom" && !f.valid) return ["range", "Add meg, mettől meddig tart az időszak (pl. 06-15 és 08-31)."];
      }
      return null;
    }
    function showError([key, msg]) {
      E.ui.err = { key, msg };
      sync();
      const box = dlg.querySelector(`[data-errkey="${key}"]:not([hidden])`) || dlg.querySelector(`[data-errkey="${key}"]`);
      const fold = box?.closest("details");
      if (fold) fold.open = true;
      const target = box?.matches("input,select,button") ? box : box?.querySelector("input,select,button");
      target?.focus({ preventScroll: true });
      box?.scrollIntoView({ block: "nearest" });
    }
    // Replaces the edited rule's items (all its days) with the new ones, in the rule's old place, so the rule order
    // the page gets back stays stable. A day that already has an identical time is not added twice.
    function submit() {
      const bad = check();
      if (bad) return showError(bad);
      const { days, ...fields } = finish(E.f), s = sig(fields);
      const gone = i => E.uids.includes(i.uid);
      const at = E.uids.length ? items.findIndex(gone) : items.length;
      const before = items.slice(0, at).filter(i => !gone(i)), after = items.slice(at).filter(i => !gone(i));
      const add = days.filter(day => ![...before, ...after].some(k => k.day === day && sig(k) === s))
        .map(day => ({ uid: uid(), day, ...fields, weeks: [...fields.weeks], tags: [...fields.tags] }));
      items = [...before, ...add, ...after];
      done(items.find(i => i.day === days[0] && sig(i) === s)?.uid, days[0]);
    }
    function remove() {
      const day = items.find(i => E.uids.includes(i.uid))?.day;
      items = items.filter(i => !E.uids.includes(i.uid));
      done(null, day);
    }
    function done(focusUid, day) {
      E.closing = true;
      dlg.close();
      renderBoard();
      onChange(join(items));
      const t = (focusUid && el.querySelector(`[data-uid="${focusUid}"]`)) || el.querySelector(`[data-add="${day}"]`);
      t?.focus({ preventScroll: true });
    }
    function onClose() {
      if (dlg.open) return; // opened again before this (queued) close event ran
      const opener = E?.opener, closing = E?.closing;
      E = null;
      if (!closing && opener && opener.isConnected) opener.focus({ preventScroll: true });
    }
    dlg.addEventListener("click", onClick);
    dlg.addEventListener("input", onInput);
    dlg.addEventListener("change", onFieldChange);
    dlg.addEventListener("keydown", onKey);
    dlg.addEventListener("close", onClose);

    renderBoard();
    return {
      setRules(rules) { if (dlg.open) dlg.close(); items = split(rules || []); renderBoard(); },
      destroy() {
        if (dlg.open) dlg.close();
        el.removeEventListener("click", onBoardClick);
        dlg.remove();
        el.innerHTML = "";
      },
    };
  }

  return { split, join, describe, mount, normalize, sig, tileText, normTime };
});
