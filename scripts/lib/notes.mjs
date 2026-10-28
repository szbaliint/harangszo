// Turns the free-text note of a schedule row into structure: tags (language, kind of Mass), the row's kind
// (Vesperás → prayer), an "every n weeks" hint — and whatever text is left for the note.
// Used by the importers; the vocabulary matches calendar.js (TAGS, LANGS).

const LANG_WORDS = { magyar: "hu", német: "de", angol: "en", latin: "la", szlovák: "sk", horvát: "hr", román: "ro", lengyel: "pl", olasz: "it",
  francia: "fr", spanyol: "es", ukrán: "uk", orosz: "ru", görög: "el", ószláv: "cu", egyházi_szláv: "cu", ruszin: "rue", szlovén: "sl", portugál: "pt",
  tagalog: "tl", cigány: "rom", lovári: "rom", beás: "rom", cseh: "cs", szerb: "sr", bolgár: "bg" };
// Codes used by miserend.hu → ours.
export const LANG_CODES = { h: "hu", hu: "hu", va: "la", la: "la", gr: "el", ua: "uk", si: "sl", cig: "rom", cz: "cs", ser: "sr" };
export const langTag = code => { const c = (LANG_CODES[code] || code || "").toLowerCase(); return /^[a-z]{2,3}$/.test(c) && c !== "hu" ? "lang:" + c : null; };

// A note part that says nothing but this → the tag, and the part is dropped.
const PURE = [
  [/^(családos|családi|családos mise|családi mise|családos szentmise|gyermekmise|gyerekmise|gyermekek miséje|kisgyermekes)$/, "family"],
  [/^(diák|diákmise|diák mise|iskolai mise|iskolai szentmise)$/, "student"],
  [/^(ifjúsági|ifjúsági mise|ifjúsági szentmise|fiatalok miséje|ifi mise)$/, "youth"],
  [/^(egyetemi|egyetemista|egyetemi mise|egyetemista mise|egyetemi lelkészség)$/, "university"],
  [/^(gitáros|gitáros mise|gitáros szentmise)$/, "guitar"],
  [/^(orgonás|orgonakísérettel)$/, "organ"],
  [/^(énekes|kórusos|kórussal|énekkaros|ének- és zenekaros|zenés|zenés mise|kántált)$/, "choir"],
  [/^(csendes|csendes mise|csendes szentmise|néma)$/, "silent"],
  [/^((vasárnapi |vasárnap )?előesti( mise| szentmise)?|elővételezett|vasárnapi elővételezett( mise)?)$/, "vigil"],
  [/^(szentmise (v\.|vagy) (ige)?liturgia|mise vagy igeliturgia|szentmise vagy igeliturgia|időnként igeliturgia|néha igeliturgia)$/, "word"],
  [/^((alatta|közben|mise alatt|a mise alatt|szentmise alatt) gyóntatás|gyóntatás a mise alatt)$/, "confession"],
  [/^(régi rítusú|tridenti|tridenti mise|usus antiquior|latin rítusú)$/, "traditional"],
  [/^(változhat|változó|alkalmanként|alkalmilag|általában|miseszándék esetén|nem minden héten|esetenként|időnként|kezdés időpontja változhat.*|változhat, igyekszünk.*|az aktuális hirdetés szerint.*|esetlegesen elmarad.*)$/, "irregular"],
];
const EVERY = [[/^(kéthetente|kéthetenként|kéthetente vasárnap|minden második héten|minden második vasárnap|páros héten|páratlan héten|páros heteken|páratlan heteken)$/, 2],
  [/^(három ?hetente|háromhetenként)$/, 3], [/^(négy ?hetente|havonta egyszer)$/, 4]];
const PRAYER = /^(vesperás|laudes|vecsernye|nagyvecsernye|kisvecsernye|utrenye|rózsafüzér|szentolvasó|keresztút|litánia|lorettói litánia|kompletórium|zsolozsma|imaóra|szentóra|akathisztosz|paraklisz|moleben|panachida|igeliturgia|dicsőítés|taizé-i imaóra|taizéi ima)$/;
const NOISE = /^(roráté|rorate|rorate mise|roráté mise|szent liturgia|extra|minden héten|szentmise|mise|hétköznapi szentmise|hétköznapi mise|vasárnapi szentmise|plébániatemplom)$/;

// Clean a note: HTML, link wrappers, the "extra" prefix, repeated parts.
export function cleanNote(t) {
  const unwrap = u => u.replace(/&amp;/g, "&").replace(/^https?:\/\/www\.google\.com\/url\?q=([^&]+).*$/, (m, x) => { try { return decodeURIComponent(x); } catch { return x; } });
  let s = String(t || "")
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (m, href, text) => { const u = unwrap(href); return !text || /^(https?:|link|itt|ide|honlap|weboldal)/i.test(text.trim()) ? u : `${text} (${u})`; })
    .replace(/<br\s*\/?>/gi, ", ").replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/https?:\/\/www\.google\.com\/url\?q=[^\s)]+/g, unwrap)
    .replace(/\s+/g, " ").trim()
    .replace(/^extra\b[\s,:]*/i, "");
  return s;
}

// → { tags: [], kind: null | "prayer" | "adoration", every: null | n, note }
// known.every: the row already repeats every n weeks (so "kéthetente" is redundant); known.weeks: it has week-of-month rules.
export function parseNote(text, known = {}) {
  const tags = new Set(), kept = []; let kind = null, every = null;
  const parts = cleanNote(text).split(/\s*,\s*(?![^()]*\))/).filter(Boolean);
  const seen = new Set();
  parts.forEach((raw, i) => {
    const part = raw.replace(/[.!]+$/, "").trim(), low = part.toLowerCase();
    if (!part || seen.has(low)) return; seen.add(low);
    if (NOISE.test(low)) return;
    if (i === 0 && PRAYER.test(low)) { kind = "prayer"; kept.push(part[0].toUpperCase() + part.slice(1)); return; }
    if (i === 0 && /^szentségimádás$/.test(low)) { kind = "adoration"; return; }
    const lang = low.match(/^([a-zá-űő –-]+?)(?: nyelvű| nyelven|ül|ul)?(?: (?:szent)?mise)?$/);
    if (lang) {
      const words = lang[1].split(/\s*(?:-|–| és | ill\. )\s*/).map(w => LANG_WORDS[w.trim().replace(/ /g, "_")]);
      if (words.length && words.every(Boolean) && (/nyelv|ül$|ul$/.test(low) || words.length === 1 && low.split(" ").length === 1)) {
        for (const w of words) if (w !== "hu") tags.add("lang:" + w);
        return;
      }
    }
    for (const [re, tag] of PURE) if (re.test(low)) { tags.add(tag); return; }
    for (const [re, n] of EVERY) if (re.test(low)) { every = n; if (known.every === n) return; kept.push(part); return; }
    // Week-of-month wording the row's rule already says.
    if (known.weeks && /^((csak|minden) )?((a )?hónap )?((\d\.|első|második|harmadik|negyedik|ötödik|utolsó)\S*( és (\d\.|első|második|harmadik|negyedik|ötödik|utolsó)\S*)?( \S+)?|elsőpénteken|elsőcsütörtökön|elsőszombaton)$|kivételével$|^első ?héten nincs$|^elsőpénteki héten nincs$/.test(low)) return;
    // Tags mentioned inside a longer sentence still count, but the sentence stays.
    if (/igeliturgia/.test(low)) tags.add("word");
    if (/(alatt|közben) gyóntat/.test(low)) tags.add("confession");
    if (/gitáros/.test(low)) tags.add("guitar");
    if (/családos|gyerekeknek|gyermekeknek/.test(low)) tags.add("family");
    kept.push(part);
  });
  return { tags: [...tags], kind, every, note: kept.join(", ").slice(0, 300) };
}
