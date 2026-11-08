"use strict";
/* Liturgical calendar helpers for Hungary, shared by the public site and the admin panel.
   Dates are plain local calendar dates (no time-of-day). */
(function (root) {
  const D = (y, m, d) => new Date(y, m - 1, d);
  const addDays = (date, n) => { const x = new Date(date.getFullYear(), date.getMonth(), date.getDate()); x.setDate(x.getDate() + n); return x; };
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const ymd = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

  // Easter Sunday (Gregorian), anonymous algorithm.
  function easter(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
      g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
      l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451), month = Math.floor((h + l - 7 * m + 114) / 31),
      day = ((h + l - 7 * m + 114) % 31) + 1;
    return D(y, month, day);
  }
  // First Sunday of Advent: the fourth Sunday before Christmas (27 Nov – 3 Dec).
  function adventStart(y) { const xmas = D(y, 12, 25), dow = xmas.getDay(); return addDays(xmas, -((dow === 0 ? 7 : dow) + 21)); }
  // Christmas time: 25 Dec – the Baptism of the Lord (the Sunday after 6 Jan; Epiphany stays on 6 Jan in Hungary).
  function baptism(y) { const e = D(y, 1, 6); return addDays(e, 7 - e.getDay()); }
  function inChristmas(date) { const y = date.getFullYear(), d = D(y, date.getMonth() + 1, date.getDate()); return d >= D(y, 12, 25) || d <= baptism(y); }
  function inAdvent(date) { const s = adventStart(date.getFullYear()), e = D(date.getFullYear(), 12, 24); return date >= s && date <= e; }

  // Summer time (EU rule, used in Hungary): from the last Sunday of March to the day before the last Sunday of October.
  const lastSunday = (y, m) => { const d = D(y, m + 1, 0); return addDays(d, -d.getDay()); };
  function isSummerTime(date) { const y = date.getFullYear(); const d = D(y, date.getMonth() + 1, date.getDate()); return d >= lastSunday(y, 3) && d < lastSunday(y, 10); }
  function nextClockChange(date) {
    const y = date.getFullYear(), d = D(y, date.getMonth() + 1, date.getDate());
    for (const c of [lastSunday(y, 3), lastSunday(y, 10), lastSunday(y + 1, 3)]) if (c > d) return c;
  }

  // Feasts editors can give a special schedule. Ascension and Corpus Christi are celebrated on Sunday in Hungary.
  const FEASTS = [
    { key: "jan1", name: "Újév – Szűz Mária, Isten Anyja", date: y => D(y, 1, 1), ob: 1, pub: 1 },
    { key: "jan6", name: "Vízkereszt", date: y => D(y, 1, 6), ob: 1 },
    { key: "feb2", name: "Gyertyaszentelő Boldogasszony", date: y => D(y, 2, 2) },
    { key: "ash_wed", name: "Hamvazószerda", date: y => addDays(easter(y), -46) },
    { key: "mar15", name: "Március 15. – nemzeti ünnep", date: y => D(y, 3, 15), pub: 1 },
    { key: "mar25", name: "Gyümölcsoltó Boldogasszony", date: y => D(y, 3, 25) },
    { key: "palm_sun", name: "Virágvasárnap", date: y => addDays(easter(y), -7) },
    { key: "holy_thu", name: "Nagycsütörtök", date: y => addDays(easter(y), -3) },
    { key: "good_fri", name: "Nagypéntek", date: y => addDays(easter(y), -2), pub: 1 },
    { key: "holy_sat", name: "Nagyszombat – húsvéti vigília", date: y => addDays(easter(y), -1) },
    { key: "easter", name: "Húsvétvasárnap", date: y => easter(y), pub: 1 },
    { key: "easter_mon", name: "Húsvéthétfő", date: y => addDays(easter(y), 1), pub: 1 },
    { key: "may1", name: "Május 1. – Szent József, a munkás", date: y => D(y, 5, 1), pub: 1 },
    { key: "ascension", name: "Urunk mennybemenetele", date: y => addDays(easter(y), 42) },
    { key: "pentecost", name: "Pünkösdvasárnap", date: y => addDays(easter(y), 49), pub: 1 },
    { key: "pentecost_mon", name: "Pünkösdhétfő", date: y => addDays(easter(y), 50), pub: 1 },
    { key: "corpus", name: "Úrnapja", date: y => addDays(easter(y), 63) },
    { key: "jun29", name: "Szent Péter és Pál apostolok", date: y => D(y, 6, 29) },
    { key: "aug15", name: "Nagyboldogasszony", date: y => D(y, 8, 15), ob: 1 },
    { key: "aug20", name: "Szent István király", date: y => D(y, 8, 20), pub: 1 },
    { key: "oct23", name: "Október 23. – nemzeti ünnep", date: y => D(y, 10, 23), pub: 1 },
    { key: "nov1", name: "Mindenszentek", date: y => D(y, 11, 1), ob: 1, pub: 1 },
    { key: "nov2", name: "Halottak napja", date: y => D(y, 11, 2) },
    { key: "christ_king", name: "Krisztus Király", date: y => addDays(adventStart(y), -7) },
    { key: "dec8", name: "Szeplőtelen fogantatás", date: y => D(y, 12, 8) },
    { key: "dec24", name: "Szenteste – éjféli mise", date: y => D(y, 12, 24), pub: 1 },
    { key: "dec25", name: "Karácsony", date: y => D(y, 12, 25), ob: 1, pub: 1 },
    { key: "dec26", name: "Karácsony másnapja", date: y => D(y, 12, 26), pub: 1 },
    { key: "dec31", name: "Év végi hálaadás", date: y => D(y, 12, 31) },
  ];
  // Groups: one schedule row or "Sunday order" for all of them. ob = holy day of obligation in Hungary (besides Sundays),
  // pub = public holiday (munkaszüneti nap). Sundays themselves are not counted.
  const FEAST_GROUPS = [
    { key: "holyday", name: "Parancsolt ünnepeken", test: f => f.ob },
    { key: "public", name: "Munkaszüneti napokon", test: f => f.pub },
  ];
  const FEAST_BY_KEY = Object.fromEntries([...FEASTS, ...FEAST_GROUPS].map(f => [f.key, f]));
  // Feasts on a date: the specific ones, then the groups they belong to (a group never on a Sunday).
  const feastsOn = date => {
    const fs = FEASTS.filter(f => sameDay(f.date(date.getFullYear()), date));
    const groups = date.getDay() === 0 ? [] : FEAST_GROUPS.filter(g => fs.some(g.test)).map(g => g.key);
    return [...fs.map(f => f.key), ...groups];
  };
  const isGroup = key => FEAST_GROUPS.some(g => g.key === key);
  // Ünnepnap for "ünnepnapokon elmarad": a holy day of obligation or a public holiday that is not a Sunday.
  const isHoliday = date => feastsOn(date).some(isGroup);
  // Next occurrence of a feast (or of any feast in a group) on or after `from`.
  function nextFeastDate(key, from) {
    const f = FEAST_BY_KEY[key]; if (!f) return null;
    const d0 = D(from.getFullYear(), from.getMonth() + 1, from.getDate());
    if (isGroup(key)) return nextDate(d0, d => feastsOn(d).includes(key));
    const a = f.date(from.getFullYear()); return a >= d0 ? a : f.date(from.getFullYear() + 1);
  }

  // `valid` = "MM-DD/MM-DD[,…]" (ranges may wrap the new year): is the date inside?
  const mdOf = d => String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  function inValid(date, valid) {
    if (!valid) return true;
    const x = mdOf(date);
    return valid.split(",").some(r => { const [a, b] = r.split("/"); return a <= b ? x >= a && x <= b : x >= a || x <= b; });
  }
  // `weeks` = [1..5, -1 = last]: is this date's weekday that week of its month?
  function weekOk(date, weeks) {
    if (!weeks || !weeks.length) return true;
    const d = date.getDate(), n = Math.ceil(d / 7), dim = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    return weeks.includes(n) || (weeks.includes(-1) && d + 7 > dim);
  }
  // Every n-th week, counted from a date it happens on (`anchor`, "YYYY-MM-DD").
  function everyOk(date, every, anchor) {
    if (!every || every < 2 || !anchor) return true;
    const [y, m, d] = anchor.split("-").map(Number);
    const days = Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(y, m - 1, d)) / 864e5);
    return ((Math.floor(days / 7) % every) + every) % every === 0;
  }
  // Next date on or after `from` (up to a year) for which test(date) holds.
  function nextDate(from, test) { for (let i = 0; i < 370; i++) { const d = addDays(from, i); if (test(d)) return d; } return null; }

  // Seasons a schedule row can belong to. Summer/winter follow the clock change; the church year's seasons move
  // with Easter and Advent; school year / summer holiday and autumn/spring use default dates unless a row gives its own range.
  const between = (d, a, b) => { const x = D(d.getFullYear(), d.getMonth() + 1, d.getDate()); return x >= a && x <= b; };
  const PERIOD_INFO = {
    all:        { name: "egész évben", adj: "" },
    summer:     { name: "nyári időszámítás idején", adj: "nyári időszámítás", test: d => isSummerTime(d) },
    winter:     { name: "téli időszámítás idején", adj: "téli időszámítás", test: d => !isSummerTime(d) },
    summer_months: { name: "nyáron (jún.–aug.)", adj: "nyári", range: "06-01/08-31" },
    winter_months: { name: "télen (dec.–febr.)", adj: "téli", range: "12-01/02-29" },
    autumn:     { name: "ősszel", adj: "őszi", range: "09-01/10-31" },
    spring:     { name: "tavasszal", adj: "tavaszi", range: "03-01/04-30" },
    advent:     { name: "adventben", adj: "adventi", test: d => inAdvent(d) },
    christmas:  { name: "karácsonyi időben", adj: "karácsonyi", test: d => inChristmas(d) },
    lent:       { name: "nagyböjtben", adj: "nagyböjti", test: d => { const e = easter(d.getFullYear()); return between(d, addDays(e, -46), addDays(e, -1)); } },
    eastertide: { name: "húsvéti időben", adj: "húsvéti", test: d => { const e = easter(d.getFullYear()); return between(d, e, addDays(e, 49)); } },
    school:     { name: "tanévben", adj: "tanévi", range: "09-01/06-15" },
    holiday:    { name: "nyári szünetben", adj: "nyári szüneti", range: "06-16/08-31" },
  };
  // Does a row with this period (and optional own date range) apply on this date?
  function inPeriod(date, period, valid) {
    if (valid) return inValid(date, valid);
    const p = PERIOD_INFO[period] || PERIOD_INFO.all;
    return p.test ? p.test(date) : p.range ? inValid(date, p.range) : true;
  }

  // What a Mass is like. Languages are "lang:<code>".
  const TAGS = {
    family: "családos", student: "diákmise", youth: "ifjúsági", university: "egyetemista", guitar: "gitáros", organ: "orgonás",
    choir: "kórussal", silent: "csendes", vigil: "előesti", word: "igeliturgia is lehet", confession: "közben gyóntatás",
    traditional: "régi rítusú", irregular: "változhat", solemn: "ünnepi",
  };
  const LANGS = { hu: "magyar", de: "német", en: "angol", la: "latin", sk: "szlovák", hr: "horvát", ro: "román", pl: "lengyel", it: "olasz", fr: "francia",
    es: "spanyol", uk: "ukrán", ru: "orosz", el: "görög", cu: "ószláv", rue: "ruszin", sl: "szlovén", pt: "portugál", tl: "tagalog", rom: "cigány", cs: "cseh", sr: "szerb" };
  const tagLabel = t => t.startsWith("lang:") ? (LANGS[t.slice(5)] || t.slice(5)) + " nyelvű" : TAGS[t] || t;

  root.LitCal = { inValid, weekOk, everyOk, nextDate, mdOf, easter, adventStart, inAdvent, isSummerTime, nextClockChange, FEASTS, FEAST_GROUPS, FEAST_BY_KEY, feastsOn, isHoliday, isGroup, nextFeastDate, inChristmas, ymd, addDays,
    PERIOD_INFO, inPeriod, TAGS, LANGS, tagLabel };
})(typeof window !== "undefined" ? window : globalThis);
