// Migration 014 (track() counts the "Most" tab) against a real Postgres (PGlite, in memory): it runs twice on the
// schema before it and on schema.sql, and track() then counts every tab and filter key the map sends, and still
// drops unknown keys.
//
// Not part of `npm test`: it needs @electric-sql/pglite, which is not a repo dependency. Run it with a directory
// that has PGlite installed (outside the repo):
//   mkdir -p /tmp/pg && (cd /tmp/pg && npm init -y >/dev/null && npm i @electric-sql/pglite)
//   PGLITE_DIR=/tmp/pg node tests/sql/track.pglite.mjs
// Exit code 0 = every check passed. Supabase's auth/storage schemas and roles are stubbed below (just enough to run).
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const dir = process.env.PGLITE_DIR;
if (!dir) { console.error("Set PGLITE_DIR to a directory with @electric-sql/pglite installed (see the comment at the top)."); process.exit(2); }
const { PGlite } = createRequire(path.resolve(dir) + "/")("@electric-sql/pglite");

const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
const MIGRATION = read("supabase/migrations/014_track_most.sql");
const STUBS = `
  create role anon; create role authenticated; create role service_role bypassrls;
  alter default privileges in schema public grant all on tables to service_role;
  alter default privileges in schema public grant all on sequences to service_role;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
  grant usage on schema auth to anon, authenticated, service_role;
  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
    name text, owner uuid default auth.uid());
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated, service_role;
  grant select, insert, update, delete on storage.objects to authenticated, service_role;
  grant select on storage.buckets to anon, authenticated, service_role;
`;

let passed = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); },
  e => { console.error("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; });
async function fresh(schemaSql) { const db = new PGlite(); await db.exec(STUBS); await db.exec(schemaSql); return db; }

console.log("Runs twice");
let before = null;
try { before = execFileSync("git", ["-C", ROOT, "show", "d392fcf:supabase/schema.sql"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { }
if (before) {
  await ok("014 twice on the schema before 014 (013 merged in)", async () => {
    const db = await fresh(before);
    await db.exec(MIGRATION); await db.exec(MIGRATION);
    const def = (await db.query(`select pg_get_functiondef('public.track(jsonb)'::regprocedure) as d`)).rows[0].d;
    assert.match(def, /'most', 'map', 'list', 'saved'/);
    await db.close();
  });
} else console.log("  (skipped: the pre-014 schema is not in this git checkout)");

const db = await fresh(read("supabase/schema.sql"));
await ok("schema.sql again, then 014 twice on top", async () => { await db.exec(read("supabase/schema.sql")); await db.exec(MIGRATION); await db.exec(MIGRATION); });

console.log("track()");
const counts = async () => Object.fromEntries((await db.query(`select event || ':' || key as k, n from public.analytics_daily`)).rows.map(r => [r.k, Number(r.n)]));
await ok("anon counts the four tabs and every filter of the map; unknown keys are dropped", async () => {
  await db.exec(`insert into public.churches (id, name, city, lat, lon, published) values (1043, 'Szent Anna', 'Eger', 47.9, 20.37, true)`);
  const events = [
    ...["most", "map", "saved", "list", "most"].map(k => ({ e: "tab", k })),
    ...["mass", "conf", "open", "ev", "rorate", "tag", "day", "origin"].map(k => ({ e: "filter", k })),
    { e: "view", k: "1043" }, { e: "dir", k: "1043" }, { e: "locate" },
    { e: "tab", k: "home" }, { e: "tab", k: "" }, { e: "filter", k: "most" }, { e: "nonsense", k: "x" }];
  await db.exec(`set role anon`);
  await db.query(`select public.track($1::jsonb)`, [JSON.stringify(events)]);
  await db.exec(`reset role`);
  const c = await counts();
  assert.deepEqual(["most", "map", "saved", "list"].map(k => c["tab:" + k]), [2, 1, 1, 1]);
  for (const k of ["mass", "conf", "open", "ev", "rorate", "tag", "day", "origin"]) assert.equal(c["filter:" + k], 1, k);
  assert.deepEqual([c["view:1043"], c["dir:1043"], c["locate:"]], [1, 1, 1]);
  for (const k of ["tab:home", "tab:", "filter:most", "nonsense:x"]) assert.equal(c[k], undefined, k);
});
await ok("analytics_report() returns the Most count among the totals (admin)", async () => {
  const ADMIN = "00000000-0000-0000-0000-00000000000a";
  await db.exec(`insert into auth.users values ('${ADMIN}'); insert into public.staff (user_id, role, display_name) values ('${ADMIN}', 'admin', 'Admin')`);
  await db.exec(`set role authenticated; select set_config('test.uid', '${ADMIN}', false)`);
  const r = (await db.query(`select public.analytics_report(7) as r`)).rows[0].r;
  await db.exec(`reset role`);
  assert.equal(r.totals["tab:most"], 2);
});

await db.close();
console.log(`${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
