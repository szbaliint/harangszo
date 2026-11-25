// "Indulások" tokens, WCAG AA contrast, the self-hosted Overpass, and the test harness itself.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "./helpers/playwright.mjs";
import { startServer, ROOT } from "./helpers/server.mjs";
import { mockSupabase } from "./helpers/supabase-mock.mjs";

const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
const fixture = name => JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures", name), "utf8"));

// Custom properties of every block whose selector matches `re` (later blocks win).
function vars(re) {
  const out = {};
  for (const m of css.matchAll(new RegExp(re.source + /\s*\{([^{}]*)\}/.source, "g")))
    for (const d of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) out[d[1]] = d[2].trim().toLowerCase();
  return out;
}
const light = vars(/:root(?![:\[])/);
const darkMedia = { ...light, ...vars(/:root:not\(\[data-theme="light"\]\)/) };
const darkAttr = { ...light, ...vars(/:root\[data-theme="dark"\]/) };
const MODES = { light, "dark (media query)": darkMedia, 'dark ([data-theme="dark"])': darkAttr };

// WCAG 2 relative luminance and contrast ratio.
function rgb(c) {
  c = c.trim().toLowerCase();
  if (c === "#fff" || c === "white") return [255, 255, 255];
  const m = /^#([0-9a-f]{6})$/.exec(c);
  assert.ok(m, `not a #rrggbb colour: ${c}`);
  return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
}
const lum = c => {
  const [r, g, b] = rgb(c).map(v => v / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test("Indulások tokens: navy board, white rows, one amber, one red", () => {
  assert.deepEqual([light["--bg"], light["--ink"], light["--ink-2"], light["--line"], light["--board"], light["--board-2"], light["--amber"], light["--now"]],
    ["#ffffff", "#14213d", "#5d6779", "#e6e9ef", "#13233f", "#1d3257", "#ffb703", "#d33a2c"]);
  assert.equal(light["--accent"], light["--ink"], "portal and admin controls are navy ink, not a colour");
  assert.equal(light["--red"], light["--now"], "red is only \"most tart\" (and errors)");
  for (const [name, t] of [["media query", darkMedia], ["[data-theme=dark]", darkAttr]]) {
    assert.deepEqual([t["--bg"], t["--ink"], t["--ink-2"], t["--ink-3"], t["--line"], t["--board"]], ["#0b1322", "#e9eef7", "#a3aec2", "#8d99af", "#1f2c45", "#13233f"], `dark (${name})`);
    assert.deepEqual([t["--amber"], t["--on-amber"], t["--now"]], [light["--amber"], light["--on-amber"], light["--now"]], `dark keeps amber and red (${name})`);
  }
  assert.equal(light["--f-display"], '"overpass", system-ui, sans-serif');
  assert.equal(light["--f-body"], '"overpass", system-ui, sans-serif');
  assert.deepEqual(["--fs-0", "--fs-1", "--fs-2", "--fs-3", "--fs-4", "--fs-title", "--fs-pass"].map(k => light[k]), ["12px", "13px", "15px", "17px", "22px", "28px", "34px"]);
  assert.deepEqual([light["--r"], light["--r-card"]], ["12px", "18px"]);
  assert.match(css, /--spring:linear\(0, /, "a sampled critically damped spring");
  assert.ok(!("--f-mono" in light), "--f-mono is removed");
});

test("contrast AA", () => {
  const pairs = [["--ink", "--bg"], ["--ink-2", "--surface"], ["--ink-3", "--surface"], ["--ink-3", "--bg"], ["--ink-2", "--chip"], ["--ink-2", "--sunken"], ["--red", "--bg"],
    ["--on-board", "--board"], ["--on-board-2", "--board"], ["--on-board-3", "--board-2"], ["--on-amber", "--amber"], ["--amber-ink", "--amber"], ["--amber-2", "--amber"], ["--amber-3", "--amber"],
    ["--on-now", "--now"], ["--on-primary", "--primary"], ["--ink", "--flash"], ["--on-pin", "--pin"], ["--ink", "--seg-on"], ["--ink", "--field"], ["--ink-2", "--field"],
    ["--accent", "--accent-soft"], ["--penance", "--penance-soft"], ["--gold", "--gold-soft"], ["--open", "--open-soft"], ["--on-accent", "--accent"],
    // The portal's and admin's unsaved rows (pale amber) and the admin's open church (the navy row).
    ["--ink-2", "--flash"], ["--on-board-2", "--board-2"]];
  for (const [mode, t] of Object.entries(MODES))
    for (const [fg, bg] of pairs) {
      const r = ratio(t[fg], t[bg]);
      assert.ok(r >= 4.5, `${mode}: ${fg} ${t[fg]} on ${bg} ${t[bg]} = ${r.toFixed(2)} < 4.5`);
    }
});

test("no old fonts", () => {
  const files = fs.readdirSync(ROOT).filter(f => /\.(html|css|js)$/.test(f));
  assert.ok(files.includes("styles.css") && files.includes("app.js"));
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const bad of ["IBM Plex", "IBM+Plex", "Spectral", "--f-mono", "monospace"])
      assert.ok(!src.includes(bad), `${f} still contains ${bad}`);
  }
});

let server, browser;
before(async () => { server = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.stop(); });

// Self-hosted type: every @font-face file is in fonts/ with its licence, deployed, small, and the only place fonts come from.
const FACES = [...css.matchAll(/@font-face\{([^}]*)\}/g)].map(m => ({
  family: /font-family:"([^"]+)"/.exec(m[1])[1], file: /url\(([^)]+)\)/.exec(m[1])[1], display: /font-display:(\w+)/.exec(m[1])?.[1], range: /unicode-range:/.test(m[1]) }));
test("fonts: Overpass, latin + latin-ext, self-hosted with its licence; the old faces are gone", () => {
  assert.deepEqual([...new Set(FACES.map(f => f.family))], ["Overpass"]);
  assert.deepEqual(FACES.map(f => f.file).sort(), ["fonts/overpass-latin-ext.woff2", "fonts/overpass-latin.woff2"]);
  for (const f of FACES) {
    assert.equal(f.display, "swap", f.file); assert.ok(f.range, `${f.file}: unicode-range`);
    const head = fs.readFileSync(path.join(ROOT, f.file)).subarray(0, 4).toString("latin1");
    assert.equal(head, "wOF2", `${f.file} is a woff2 file`);
  }
  const total = FACES.reduce((n, f) => n + fs.statSync(path.join(ROOT, f.file)).size, 0);
  assert.ok(total < 150 * 1024, `fonts total ${Math.round(total / 1024)} KB`);
  assert.match(fs.readFileSync(path.join(ROOT, "fonts/OFL-Overpass.txt"), "utf8"), /The Overpass Project Authors[\s\S]*SIL Open Font License, Version 1\.1/);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "fonts")).sort(), ["OFL-Overpass.txt", "overpass-latin-ext.woff2", "overpass-latin.woff2"], "nothing else in fonts/");
  const yml = fs.readFileSync(path.join(ROOT, ".github/workflows/pages.yml"), "utf8");
  assert.match(yml, /^\s*cp -r [^\n]*\bfonts\b[^\n]*_site\/?\s*$/m, "pages.yml deploys fonts/");
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  for (const f of FACES) assert.ok(sw.includes(`"${f.file}"`), `sw.js keeps ${f.file} for the map`);
  assert.match(sw, /const FONT_CACHE = "harangszo-fonts-2";/, "a new font cache for the new files");
  const index = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(index, /<link rel="preload" href="fonts\/overpass-latin\.woff2" as="font" type="font\/woff2" crossorigin>/, "index.html preloads Overpass");
  for (const f of ["index.html", "styles.css", "app.js", "sw.js", "plebania.html", "admin.html", "jogi.html"])
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), "utf8"), /newsreader-|source-sans-3-/, `${f} loads no old font file`);
});

test("pages use the self-hosted Overpass and nothing from Google Fonts; its middle dot has a width", async () => {
  for (const file of ["index.html", "plebania.html", "admin.html", "jogi.html"]) {
    const page = await browser.newPage();
    const external = [];
    page.on("request", r => { if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) external.push(r.url()); });
    try {
      await mockSupabase(page, {});
      await page.goto(`${server.url}/${file}`, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
      assert.match(family, /^"?Overpass"?, system-ui, sans-serif$/, `${file}: body font is ${family}`);
      assert.ok(await page.evaluate(() => document.fonts.check('800 15px "Overpass"')), `${file}: Overpass loaded`);
      assert.deepEqual(external, [], `${file}: no Google Fonts requests`);
      if (file === "index.html") {
        // " · " joins every meta line: the dot must take its own width (upstream classes it as a mark; ours is patched).
        const w = await page.evaluate(async () => { await document.fonts.load('600 40px "Overpass"', "·"); const s = document.createElement("span");
          s.style.cssText = 'font:600 40px "Overpass";white-space:pre'; s.textContent = "·"; document.body.append(s); const r = s.getBoundingClientRect().width; s.remove(); return r; });
        assert.ok(w > 5, `the middle dot is ${w}px wide`);
      }
    } finally { await page.close(); }
  }
});

test("mockSupabase: a parish user gets past the login screen", async () => {
  const parish = fixture("staff-parish.json");
  const church = fixture("church-1043.json");
  const page = await browser.newPage();
  try {
    const { calls } = await mockSupabase(page, { user: parish.user, staff: parish.staff, tables: { staff_churches: parish.staff_churches, churches: [church] } });
    await page.goto(`${server.url}/plebania.html`);
    await page.getByRole("heading", { name: church.name }).first().waitFor({ timeout: 15000 });
    assert.equal(await page.locator("#auth").count(), 0, "login form is not shown");
    assert.ok(calls.some(c => c.path === "/rest/v1/staff" && c.method === "GET"), "staff row was read");
    assert.ok(calls.some(c => c.path === "/rest/v1/churches" && /id=eq\.1043/.test(c.query)), "church 1043 was opened");
  } finally { await page.close(); }
});

test("mockSupabase: signed out shows the admin login", async () => {
  const page = await browser.newPage();
  try {
    await mockSupabase(page, {});
    await page.goto(`${server.url}/admin.html`);
    await page.locator("#pw").waitFor({ timeout: 15000 });
  } finally { await page.close(); }
});
