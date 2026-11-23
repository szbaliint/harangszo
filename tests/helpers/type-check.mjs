// The type rules of styles.css, checked on every element of a page: Newsreader (400/500) only for church names,
// headings and the "Harangszó" wordmark, everything else Source Sans 3 at 300 (big times), 400 or 600; no 700, no other family.
//   assert.deepEqual(await typeProblems(page), []);
export const NAMES = "h1, h2, h3, h4, h5, h6, summary, .r-name, .mc-t strong, .ui-empty strong, .ad-it .nm, .pp-results .ui-row b, .pp-req b, .ad-logo, .pp-brand, .lg-brand";

export function typeProblems(page, names = NAMES) {
  return page.evaluate(names => [...document.querySelectorAll("body, body *")].filter(e => !(e instanceof SVGElement)).map(e => {
    const s = getComputedStyle(e), fam = s.fontFamily.split(",")[0].replace(/"/g, "").trim(), w = +s.fontWeight;
    return {
      what: e.tagName + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().replace(/\s+/g, ".") : ""), fam, w,
      ok: ["Newsreader", "Source Sans 3"].includes(fam) && (fam === "Newsreader" ? !!e.closest(names) && (w === 400 || w === 500) : [300, 400, 600].includes(w)),
    };
  }).filter(x => !x.ok).map(({ what, fam, w }) => `${what}: ${fam} ${w}`), names);
}
