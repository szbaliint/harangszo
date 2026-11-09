// Serves the repo root with `python3 -m http.server` on a free port, the way the site is tested locally.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.unref();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function waitUp(url, proc, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (proc.exitCode !== null) throw new Error(`http.server exited with code ${proc.exitCode}`);
    try { const r = await fetch(url, { method: "HEAD" }); if (r.ok) return; } catch (_) { }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`http.server did not start at ${url}`);
}

export async function startServer() {
  const port = await freePort();
  const proc = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", ROOT], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  try { await waitUp(url + "/index.html", proc); } catch (e) { proc.kill(); throw e; }
  return {
    url,
    stop: () => new Promise(resolve => {
      if (proc.exitCode !== null) return resolve();
      proc.once("exit", () => resolve());
      proc.kill();
    }),
  };
}
