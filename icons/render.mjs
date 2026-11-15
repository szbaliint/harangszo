// Renders the PNG icons from bell.svg with the globally installed Playwright: node icons/render.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../tests/helpers/playwright.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(path.join(dir, "bell.svg"), "utf8");
const SIZES = { "icon-192.png": 192, "icon-512.png": 512, "maskable-512.png": 512, "apple-touch-icon-180.png": 180 };

const browser = await chromium.launch();
try {
  for (const [name, size] of Object.entries(SIZES)) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: path.join(dir, name), omitBackground: false });
    await page.close();
    console.log(name, size);
  }
} finally { await browser.close(); }
