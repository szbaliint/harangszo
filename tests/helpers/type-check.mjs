// The type rules of styles.css, checked on every element of a page: Overpass for everything (no other family), at 400
// (running text), 600 (meta), 700 (labels, controls) or 800 (times, names, headings). The parish portal, the admin and
// jogi.html still carry their own 300/500 weights until their restyle (`interim: true`).
//   assert.deepEqual(await typeProblems(page), []);
export const WEIGHTS = [400, 600, 700, 800];
export const INTERIM_WEIGHTS = [300, 400, 500, 600, 700, 800];

export function typeProblems(page, { interim = false } = {}) {
  return page.evaluate(weights => [...document.querySelectorAll("body, body *")].filter(e => !(e instanceof SVGElement)).map(e => {
    const s = getComputedStyle(e), fam = s.fontFamily.split(",")[0].replace(/"/g, "").trim(), w = +s.fontWeight;
    return {
      what: e.tagName + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().replace(/\s+/g, ".") : ""), fam, w,
      ok: fam === "Overpass" && weights.includes(w),
    };
  }).filter(x => !x.ok).map(({ what, fam, w }) => `${what}: ${fam} ${w}`), interim ? INTERIM_WEIGHTS : WEIGHTS);
}
