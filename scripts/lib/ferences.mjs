// The Pest Franciscans' (Budapest, Ferenciek tere) weekly "Mise- és gyóntatási rend" PDF → dated schedule rows.
//
// Each page has one or two days. A day starts with a heading "2026. nov. 1. vasárnap — …", then two columns:
//   left  (x < 180): a time, then either the celebrant ("P. Kamill") → Mass, or a liturgy ("Vesperás", "Litánia",
//                    "Szentségimádás", "Keresztút", "Rózsafüzér") → prayer / adoration
//   middle (180–320): Mass intentions — names of private people. Never read, never stored.
//   right (320–360): confession hours ("6:00", "7:00"… one row per hour); x ≥ 360: the confessors' names, not stored.
// Input: pdf.js text items per page ({x, y, str}). Output: [{date, kind, start, end, note, celebrant}]; celebrant = the
// priest named in the left column for a Mass (the public "ki tartja"), nothing else.

const MONTHS = { jan: 1, febr: 2, feb: 2, márc: 3, marc: 3, ápr: 4, apr: 4, máj: 5, maj: 5, jún: 6, jun: 6, júl: 7, jul: 7, aug: 8, szept: 9, szep: 9, okt: 10, nov: 11, dec: 12 };
const HEAD = /^(\d{4})\.\s*([a-záéíóöőúüű]+)\.?\s*(\d{1,2})\.\s*(vasárnap|hétfő|kedd|szerda|csütörtök|péntek|szombat)(?=\s|$)\s*(?:[—–-]\s*(.*))?$/i;
const TIME = /^(\d{1,2})[:.](\d{2})\b\s*(.*)$/;
// A left-column label that names a priest ("P. Kamill", "Fr. Ivan", "Bíró László püspök"); anything else is a note.
const PERSON = /^(P|Fr|Br|Dr|Mons)\.\s|(?:^|\s)(atya|testvér|püspök|érsek|plébános|káplán|diakónus)(?=[\s,.;]|$)/i;
const pad = n => String(n).padStart(2, "0");
const hm = (h, m) => `${pad(h)}:${pad(m)}`;

// What a left-column label means. A label that is none of these is a celebrant → Mass.
function liturgy(label) {
  const l = label.toLowerCase();
  if (/szentségimádás|szentség-imádás|szentóra/.test(l)) return { kind: "adoration", note: label.replace(/^szentségimádás\s*[—–-]?\s*/i, "").replace(/^\((.*)\)$/, "$1") };
  if (/vesperás|laudes|litánia|keresztút|rózsafüzér|zsolozsma|kompletórium|imaóra|ájtatosság|igeliturgia/.test(l)) return { kind: "prayer", note: label };
  return null;
}

export function parseWeek(pages) {
  const rows = [];
  for (const items of pages) {
    const it = items.map(i => ({ x: +i.x, y: +i.y, s: String(i.str || "").trim() })).filter(i => i.s);
    // Day headings on this page, top to bottom (PDF y grows upwards).
    const heads = it.filter(i => i.x < 120 && HEAD.test(i.s)).sort((a, b) => b.y - a.y);
    for (let h = 0; h < heads.length; h++) {
      const m = heads[h].s.match(HEAD);
      const mon = MONTHS[m[2].toLowerCase().replace(/\.$/, "")]; if (!mon) continue;
      const date = `${m[1]}-${pad(mon)}-${pad(+m[3])}`;
      const top = heads[h].y, bottom = h + 1 < heads.length ? heads[h + 1].y : -Infinity;
      const inDay = it.filter(i => i.y < top && i.y > bottom);
      // Left column: times with their label on (about) the same line.
      const left = inDay.filter(i => i.x < 180);
      const labels = left.filter(i => i.x >= 80 && !TIME.test(i.s));
      for (const t of left.filter(i => i.x < 80 && TIME.test(i.s))) {
        const tm = t.s.match(TIME), start = hm(+tm[1], +tm[2]);
        const label = tm[3] || labels.filter(l => Math.abs(l.y - t.y) <= 4).sort((a, b) => Math.abs(a.y - t.y) - Math.abs(b.y - t.y))[0]?.s || "";
        const lit = liturgy(label);
        rows.push(lit ? { date, kind: lit.kind, start, end: "", note: lit.note, celebrant: "" }
          : PERSON.test(label) ? { date, kind: "mass", start, end: "", note: "", celebrant: label.replace(/\s+/g, " ").trim().slice(0, 80) }
          : { date, kind: "mass", start, end: "", note: label.trim().slice(0, 120), celebrant: "" });
      }
      // Right column: confession hours → continuous ranges.
      const hours = [...new Set(inDay.filter(i => i.x >= 320 && i.x < 360 && TIME.test(i.s)).map(i => { const tm = i.s.match(TIME); return +tm[1] * 60 + +tm[2]; }))].sort((a, b) => a - b);
      for (let i = 0; i < hours.length; ) {
        let j = i; while (j + 1 < hours.length && hours[j + 1] - hours[j] === 60) j++;
        const end = hours[j] + 60;
        rows.push({ date, kind: "confession", start: hm(Math.floor(hours[i] / 60), hours[i] % 60), end: end >= 1440 ? "23:59" : hm(Math.floor(end / 60), end % 60), note: "" });
        i = j + 1;
      }
    }
  }
  // Duplicates (a line split across two text items) and order.
  const seen = new Set();
  return rows.filter(r => { const k = [r.date, r.kind, r.start, r.note].join("|"); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}

// pdf.js → items per page. Loaded lazily so the parser can be tested without pdf.js.
export async function pdfItems(buf) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    pages.push(tc.items.map(i => ({ x: Math.round(i.transform[4]), y: Math.round(i.transform[5]), str: i.str })));
  }
  return pages;
}
