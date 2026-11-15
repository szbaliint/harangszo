// "The church first" tokens, WCAG AA contrast, the platform font, and the test harness itself.
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

const STACK = '-apple-system, "sf pro text", roboto, system-ui, sans-serif';
test("church-first tokens", () => {
  assert.deepEqual([light["--bg"], light["--ink"], light["--ink-2"], light["--line"], light["--red"]], ["#ffffff", "#111111", "#555555", "#e6e6e6", "#b4232a"]);
  assert.equal(light["--accent"], light["--ink"], "controls are ink, not a colour");
  for (const [name, t] of [["media query", darkMedia], ["[data-theme=dark]", darkAttr]])
    assert.deepEqual([t["--bg"], t["--ink"], t["--ink-2"], t["--ink-3"], t["--line"], t["--red"]], ["#0e0e0e", "#f1f1f1", "#a3a3a3", "#7d7d7d", "#262626", "#ff5a5f"], `dark (${name})`);
  assert.equal(light["--f-display"], STACK);
  assert.equal(light["--f-body"], STACK);
  assert.deepEqual(["--fs-1", "--fs-2", "--fs-3", "--fs-4", "--fs-mid", "--fs-big"].map(k => light[k]), ["13px", "15px", "17px", "22px", "40px", "64px"]);
  assert.equal(light["--r"], "10px");
  assert.ok(!("--f-mono" in light), "--f-mono is removed");
});

test("contrast AA", () => {
  const pairs = [["--ink", "--bg"], ["--ink-2", "--surface"], ["--ink-3", "--surface"], ["--ink-3", "--bg"], ["--red", "--bg"],
    ["--accent", "--accent-soft"], ["--penance", "--penance-soft"], ["--gold", "--gold-soft"], ["--open", "--open-soft"], ["--on-accent", "--accent"]];
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

test("pages use the platform font; the map loads no web font", async () => {
  for (const file of ["index.html", "plebania.html", "admin.html"]) {
    const page = await browser.newPage();
    try {
      await page.goto(`${server.url}/${file}`, { waitUntil: "domcontentloaded" });
      if (file === "index.html") {
        const links = await page.$$eval('link[rel="stylesheet"]', ls => ls.map(l => l.href));
        assert.ok(!links.some(h => h.includes("fonts.googleapis.com")), "index.html: no Google Fonts stylesheet");
      }
      const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
      assert.match(family, /^-apple-system, "SF Pro Text", Roboto, system-ui, sans-serif$/, `${file}: body font is ${family}`);
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
