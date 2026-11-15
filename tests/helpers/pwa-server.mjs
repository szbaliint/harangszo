// A static server for the service-worker tests. The worker fetches its precache itself, where Playwright's
// page.route cannot reach, so the test config.js is served by the server instead of a route:
// - /config.js points at the fake Supabase project of supabase-mock.mjs (live mode);
// - /sw.js gets `__BUILD__` replaced by `server.build` when that is set (to publish a "new version").
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./server.mjs";
import { SUPABASE_URL, ANON_KEY } from "./supabase-mock.mjs";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png",
  ".svg": "image/svg+xml", ".md": "text/markdown; charset=utf-8" };
export const TEST_CONFIG = `window.HARANGSZO_CONFIG = { googleMapsKey: "__GOOGLE_MAPS_KEY__", supabaseUrl: "${SUPABASE_URL}", supabaseAnonKey: "${ANON_KEY}", repo: "szbaliint/harangszo" };`;

export async function startPwaServer() {
  const state = { build: null, url: "" };
  const srv = http.createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const rel = p === "/" ? "index.html" : p.slice(1);
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    let body;
    if (rel === "config.js") body = TEST_CONFIG;
    else {
      try { body = await readFile(file); } catch (_) { res.writeHead(404, { "content-type": "text/plain" }).end("not found"); return; }
      if (rel === "sw.js" && state.build) body = body.toString("utf8").replace("__BUILD__", state.build);
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(rel)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  state.url = `http://127.0.0.1:${srv.address().port}`;
  state.stop = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); });
  return state;
}
