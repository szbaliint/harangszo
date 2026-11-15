// Playwright is installed globally (no project dependencies). Resolve it locally first, then from `npm root -g`.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import path from "node:path";

const require = createRequire(import.meta.url);
let pw;
try { pw = require("playwright"); }
catch (_) { pw = require(path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "playwright")); }

export const { chromium, devices } = pw;
