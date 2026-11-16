// Migration 015 (a church's own feast days) against a real Postgres (PGlite, in memory): it runs twice on the schema
// before it and on schema.sql (same functions either way), the own_feasts check, save_church() round trips for an admin
// and a parish editor, public_data(), import_church_schedule() keeping own-feast rows, merge_churches(), admin_church_list.
//
// Not part of `npm test`: it needs @electric-sql/pglite, which is not a repo dependency. Run it with a directory
// that has PGlite installed (outside the repo):
//   mkdir -p /tmp/pg && (cd /tmp/pg && npm init -y >/dev/null && npm i @electric-sql/pglite)
//   PGLITE_DIR=/tmp/pg node tests/sql/own-feasts.pglite.mjs
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
const MIGRATION = read("supabase/migrations/015_own_feasts.sql");
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

async function fresh(schemaSql) {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(schemaSql);
  return db;
}
// What 015 defines, as Postgres stores it: compared between "old schema + 015" and schema.sql.
const DEFS = `
  select p.proname as name, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('own_feasts_ok', 'save_church', 'public_data', 'merge_churches', 'import_church_schedule')
  union all select 'admin_church_list', pg_get_viewdef('public.admin_church_list'::regclass, true)
  union all select conname, pg_get_constraintdef(oid) from pg_constraint where conname = 'churches_own_feasts_check'
  union all select 'own_feasts column', column_default || ' ' || is_nullable || ' ' || data_type from information_schema.columns where table_name = 'churches' and column_name = 'own_feasts'
  order by 1`;

// ── 1. The migration runs on the state before it (twice), and schema.sql (with 015 merged in) runs twice too. ──
console.log("Runs twice");
let oldSchema = null;
try { oldSchema = execFileSync("git", ["-C", ROOT, "show", "f7d4ece:supabase/schema.sql"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { }
const db = await fresh(read("supabase/schema.sql"));
await ok("schema.sql again, then 015 twice on top", async () => { await db.exec(read("supabase/schema.sql")); await db.exec(MIGRATION); await db.exec(MIGRATION); });
if (oldSchema) {
  await ok("015 twice on the schema before 015; it defines exactly what schema.sql does", async () => {
    const old = await fresh(oldSchema);
    await old.exec(`insert into public.churches (id, name, lat, lon) values (1, 'Régi', 47, 19)`);
    await old.exec(MIGRATION); await old.exec(MIGRATION);
    assert.deepEqual((await old.query(`select own_feasts from public.churches`)).rows, [{ own_feasts: [] }], "existing churches get []");
    assert.deepEqual((await old.query(DEFS)).rows, (await db.query(DEFS)).rows);
    await old.close();
  });
} else console.log("  (skipped: the pre-015 schema is not in this git checkout)");

// ── Fixtures ──
const ADMIN = "00000000-0000-0000-0000-00000000000a", PAR = "00000000-0000-0000-0000-00000000000b";
await db.exec(`
  insert into auth.users values ('${ADMIN}'), ('${PAR}');
  insert into public.staff (user_id, role, display_name) values ('${ADMIN}', 'admin', 'Admin'), ('${PAR}', 'parish', 'Szent Anna plébánia');
  insert into public.churches (id, name, city, lat, lon) values (1, 'Szent Anna', 'Eger', 47.9, 20.37), (2, 'Másik', 'Vác', 47.7, 19.1);
  insert into public.staff_churches values ('${PAR}', 1);
  select setval(pg_get_serial_sequence('public.churches', 'id'), 1000);
`);
const q = async (sql, params) => (await db.query(sql, params)).rows;
async function as(role, uid, fn) {
  await db.exec(`set test.uid = '${uid || ""}'; set role ${role}`);
  try { return await fn(); } finally { await db.exec("reset role; set test.uid = ''"); }
}
const parish = fn => as("authenticated", PAR, fn), admin = fn => as("authenticated", ADMIN, fn), service = fn => as("service_role", "", fn);
const church = async id => (await q(`select own_feasts, feast_sunday, schedule_locked, parish_updated_by from public.churches where id = $1`, [id]))[0];
const svc = async id => (await q(`select kind, days, to_char(start_time, 'HH24:MI') as start, feast from public.services where church_id = $1 order by feast nulls first, start_time`, [id]));
const BASE = { id: 1, name: "Szent Anna", city: "Eger", lat: 47.9, lon: 20.37, hours: [], events: [] };
const REGULAR = [{ kind: "mass", days: [0], start: "10:00" }, { kind: "mass", days: [1, 2, 3, 4, 5], start: "18:00" }];
const save = (p, who = admin) => who(() => q(`select public.save_church($1::jsonb) as id`, [JSON.stringify({ ...BASE, ...p })]));
const pub = async id => (await as("anon", "", () => q("select public.public_data() d")))[0].d.find(c => c.id === id);
const ANNA = { key: "own_1", name: "Szent Anna búcsú", md: "07-26" };

// ── 2. save_church round trip ──
console.log("save_church()");
await ok("admin: own feast with its own times; the name is trimmed; public_data returns it", async () => {
  await save({ own_feasts: [{ ...ANNA, name: "  Szent Anna búcsú " }], feast_sunday: ["jan6"],
    services: [...REGULAR, { kind: "mass", days: [], start: "09:00", feast: "own_1", note: "Búcsúi szentmise" }, { kind: "mass", days: [], start: "11:00", feast: "own_1" }] });
  const c = await church(1);
  assert.deepEqual(c.own_feasts, [ANNA]);
  assert.deepEqual(c.feast_sunday, ["jan6"]);
  assert.deepEqual((await svc(1)).filter(s => s.feast).map(s => [s.start, s.feast, s.days]), [["09:00", "own_1", []], ["11:00", "own_1", []]]);
  const p = await pub(1);
  assert.deepEqual(p.own_feasts, [ANNA]);
  assert.ok(p.services.some(s => s.feast === "own_1" && s.start === "09:00" && s.note === "Búcsúi szentmise"));
  assert.ok(!("own_feasts" in await pub(2)), "a church without own feasts has no own_feasts key");
});
await ok("Sunday order for an own feast: its key in feast_sunday; 02-29 is a valid day", async () => {
  const own = [ANNA, { key: "own_2", name: "Szökőnapi ünnep", md: "02-29" }];
  await save({ own_feasts: own, feast_sunday: ["own_2"], services: [...REGULAR, { kind: "mass", days: [], start: "09:00", feast: "own_1" }] });
  const c = await church(1);
  assert.deepEqual([c.own_feasts, c.feast_sunday], [own, ["own_2"]]);
});
await ok("a payload without own_feasts leaves them as they are", async () => {
  await save({ feast_sunday: ["own_2"], services: [...REGULAR, { kind: "mass", days: [], start: "09:00", feast: "own_1" }] });
  assert.equal((await church(1)).own_feasts.length, 2);
  assert.equal((await svc(1)).filter(s => s.feast === "own_1").length, 1);
});
await ok("removing an own feast drops its times and its Sunday-order entry, even if the payload still has them", async () => {
  await save({ own_feasts: [ANNA], feast_sunday: ["own_2", "jan6"], services: [...REGULAR, { kind: "mass", days: [], start: "09:00", feast: "own_1" },
    { kind: "mass", days: [], start: "08:00", feast: "own_2" }, { kind: "mass", days: [], start: "09:00", feast: "aug15" }] });
  const c = await church(1);
  assert.deepEqual([c.own_feasts, c.feast_sunday], [[ANNA], ["jan6"]]);
  assert.deepEqual((await svc(1)).filter(s => s.feast).map(s => s.feast), ["aug15", "own_1"]);
  await save({ own_feasts: [], feast_sunday: [], services: [...REGULAR, { kind: "mass", days: [], start: "09:00", feast: "own_1" }] });
  assert.deepEqual((await church(1)).own_feasts, []);
  assert.deepEqual((await svc(1)).filter(s => s.feast), []);
  assert.ok(!("own_feasts" in await pub(1)));
});
await ok("a new church can be saved with own feasts", async () => {
  const id = (await save({ id: null, name: "Új templom", own_feasts: [ANNA], feast_sunday: ["own_1"], services: REGULAR }))[0].id;
  assert.deepEqual((await church(id)).own_feasts, [ANNA]);
  assert.deepEqual((await church(id)).feast_sunday, ["own_1"]);
  await db.exec(`delete from public.churches where id = ${id}`);
});

// ── 3. Validation ──
console.log("own_feasts check");
const long = "Á".repeat(81);
for (const [what, own] of [
  ["a day that does not exist (02-30)", [{ ...ANNA, md: "02-30" }]], ["04-31", [{ ...ANNA, md: "04-31" }]], ["month 13", [{ ...ANNA, md: "13-01" }]],
  ["a date without leading zeros", [{ ...ANNA, md: "7-26" }]], ["a full date", [{ ...ANNA, md: "2027-07-26" }]], ["no date", [{ key: "own_1", name: "X" }]],
  ["a built-in feast's key", [{ ...ANNA, key: "aug15" }]], ["own_x", [{ ...ANNA, key: "own_x" }]], ["own_1000", [{ ...ANNA, key: "own_1000" }]],
  ["the same key twice", [ANNA, { ...ANNA, md: "08-01" }]], ["an 81-character name", [{ ...ANNA, name: long }]], ["an empty name", [{ ...ANNA, name: "   " }]],
  ["a name with a line break", [{ ...ANNA, name: "Szent\nAnna" }]], ["a missing name", [{ key: "own_1", md: "07-26" }]], ["11 feasts",Array.from({ length: 11 }, (_, i) => ({ key: "own_" + (i + 1), name: "Ünnep " + i, md: "01-0" + ((i % 9) + 1) }))],
  ["a string instead of a list", "Szent Anna"], ["a list of strings", ["own_1"]], ["an object instead of a list", ANNA],
]) {
  await ok("save_church refuses " + what, () => assert.rejects(save({ own_feasts: own, services: REGULAR }), /churches_own_feasts_check/));
}
await ok("an 80-character name, 10 feasts and 12-31 are fine", async () => {
  const own = Array.from({ length: 10 }, (_, i) => ({ key: "own_" + (i + 1), name: i ? "Ünnep " + i : "Á".repeat(80), md: i ? "0" + i + "-15" : "12-31" }));
  await save({ own_feasts: own, services: REGULAR });
  assert.equal((await church(1)).own_feasts.length, 10);
});
await ok("save_church keeps only key, name and md (a number as name becomes text)", async () => {
  await save({ own_feasts: [{ ...ANNA, x: 1 }, { key: "own_2", name: 5, md: "08-01" }], services: REGULAR });
  assert.deepEqual((await church(1)).own_feasts, [ANNA, { key: "own_2", name: "5", md: "08-01" }]);
});
await ok("direct updates are checked too", async () => {
  const upd = own => admin(() => q(`update public.churches set own_feasts = $1::jsonb where id = 1`, [JSON.stringify(own)]));
  for (const own of [[{ ...ANNA, md: "02-30" }], [{ ...ANNA, x: 1 }], [{ ...ANNA, name: 5 }], [{ ...ANNA, name: " Szent Anna" }], {}])
    await assert.rejects(upd(own), /churches_own_feasts_check/, JSON.stringify(own));
  await assert.rejects(db.query(`update public.churches set own_feasts = null where id = 1`), /not-null|null value/);
});

// ── 4. Parish editors ──
console.log("Parish editors");
await ok("a parish editor saves own feasts through save_church (churches_guard keeps them)", async () => {
  await save({ own_feasts: [], services: REGULAR });
  await save({ own_feasts: [{ key: "own_1", name: "Búcsú", md: "11-11" }], feast_sunday: [], services: [...REGULAR, { kind: "mass", days: [], start: "10:30", feast: "own_1" }] }, parish);
  const c = await church(1);
  assert.deepEqual(c.own_feasts, [{ key: "own_1", name: "Búcsú", md: "11-11" }]);
  assert.equal(c.schedule_locked, true); assert.equal(c.parish_updated_by, PAR);
  assert.deepEqual((await svc(1)).filter(s => s.feast).map(s => [s.feast, s.start]), [["own_1", "10:30"]]);
});
await ok("a parish editor may change own_feasts directly, and is checked like everyone", async () => {
  await parish(() => q(`update public.churches set own_feasts = $1::jsonb where id = 1`, [JSON.stringify([ANNA])]));
  assert.deepEqual((await church(1)).own_feasts, [ANNA]);
  await assert.rejects(parish(() => q(`update public.churches set own_feasts = '[{"key":"own_1","name":"","md":"07-26"}]' where id = 1`)), /churches_own_feasts_check/);
});
await ok("a parish editor cannot touch another church's own feasts (RLS)", async () => {
  const res = await parish(() => db.query(`update public.churches set own_feasts = $1::jsonb where id = 2`, [JSON.stringify([ANNA])]));
  assert.equal(res.affectedRows, 0); assert.deepEqual((await church(2)).own_feasts, []);
  await assert.rejects(save({ id: 2, name: "Másik", own_feasts: [ANNA], services: [] }, parish), /nincs jogod/);
});

// ── 5. Imports and the admin list ──
console.log("import_church_schedule(), admin_church_list");
await ok("an import replaces regular rows and its own feast keys, never the own-feast rows", async () => {
  await save({ own_feasts: [ANNA], feast_sunday: [], schedule_locked: false,
    services: [...REGULAR, { kind: "mass", days: [], start: "09:00", feast: "own_1" }, { kind: "mass", days: [], start: "08:00", feast: "aug15" }] });
  await db.exec(`update public.churches set schedule_source = 'miserend', schedule_locked = false where id = 1`);
  const r = (await service(() => q(`select public.import_church_schedule($1::jsonb) r`, [JSON.stringify({ church_id: 1, source: "miserend",
    services: [{ kind: "mass", days: [0], start: "11:00" }, { kind: "mass", days: [], start: "10:00", feast: "aug15" }] })])))[0].r;
  assert.equal(r, "updated");
  assert.deepEqual((await svc(1)).map(s => [s.feast, s.start]), [[null, "11:00"], ["aug15", "10:00"], ["own_1", "09:00"]]);
  assert.deepEqual((await church(1)).own_feasts, [ANNA]);
});
await ok("has_feast counts own feasts, even with no times of their own", async () => {
  await db.exec(`delete from public.services where church_id = 2; update public.churches set feast_sunday = '{}', own_feasts = '[]' where id = 2`);
  const flag = async () => (await admin(() => q(`select has_feast from public.admin_church_list where id = 2`)))[0].has_feast;
  assert.equal(await flag(), false);
  await db.exec(`update public.churches set own_feasts = '[{"key":"own_1","name":"Búcsú","md":"05-01"}]' where id = 2`);
  assert.equal(await flag(), true);
});

// ── 6. merge_churches ──
console.log("merge_churches()");
let nextId = 100;
// Two churches with the given own feasts, regular times and own-feast rows; returns their ids.
async function pair(keepOwn, dropOwn, { keepRegular = true, dropRegular = true } = {}) {
  const mk = async (name, own, regular, start) => {
    const id = nextId++;
    await db.exec(`insert into public.churches (id, name, lat, lon, own_feasts, feast_sunday) values (${id}, '${name}', 47, 19, '${JSON.stringify(own)}', '{${own.filter((_, i) => i % 2).map(f => f.key).join(",")}}')`);
    if (regular) await db.exec(`insert into public.services (church_id, kind, days, start_time) values (${id}, 'mass', '{0}', '${start}')`);
    for (const [i, f] of own.entries()) if (!(i % 2)) await db.exec(`insert into public.services (church_id, kind, days, start_time, feast) values (${id}, 'mass', '{}', '${start}', '${f.key}')`);
    return id;
  };
  return [await mk("Marad", keepOwn, keepRegular, "10:00"), await mk("Megszűnik", dropOwn, dropRegular, "11:00")];
}
const merge = (k, d, from = "auto") => admin(() => q(`select public.merge_churches($1, $2, $3)`, [k, d, from]));
const KEEP = [{ key: "own_1", name: "Szent Anna búcsú", md: "07-26" }], DROP = [{ key: "own_1", name: "Szent Joakim", md: "07-25" }, { key: "own_2", name: "Templomszentelés", md: "10-03" }];
await ok("times kept from the kept church: its own feasts stay, the other's go", async () => {
  const [k, d] = await pair(KEEP, DROP);
  await merge(k, d, "keep");
  const c = await church(k);
  assert.deepEqual([c.own_feasts, c.feast_sunday], [KEEP, []]);
  assert.deepEqual((await svc(k)).map(s => [s.feast, s.start]), [[null, "10:00"], ["own_1", "10:00"]]);
});
await ok("times kept from the kept church that has no own feasts: the other's come over with their times and Sunday order", async () => {
  const [k, d] = await pair([], DROP);
  await merge(k, d, "keep");
  const c = await church(k);
  assert.deepEqual([c.own_feasts, c.feast_sunday], [DROP, ["own_2"]]);
  assert.deepEqual((await svc(k)).map(s => [s.feast, s.start]), [[null, "10:00"], ["own_1", "11:00"]]);
});
await ok("times taken from the other church: its own feasts come with them", async () => {
  const [k, d] = await pair(KEEP, DROP);
  await merge(k, d, "drop");
  const c = await church(k);
  assert.deepEqual([c.own_feasts, c.feast_sunday], [DROP, ["own_2"]]);
  assert.deepEqual((await svc(k)).map(s => [s.feast, s.start]), [[null, "11:00"], ["own_1", "11:00"]]);
});
await ok("times taken from the other church that has no own feasts: the kept church's own feasts stay with their times", async () => {
  const [k, d] = await pair(DROP, [], { keepRegular: false });
  await merge(k, d);   // auto: the kept church's own-feast rows count as its times, so they are kept
  const c = await church(k);
  assert.deepEqual([c.own_feasts, c.feast_sunday], [DROP, ["own_2"]]);
  const [k2, d2] = await pair(DROP, []);
  await merge(k2, d2, "drop");
  const c2 = await church(k2);
  assert.deepEqual([c2.own_feasts, c2.feast_sunday], [DROP, ["own_2"]]);
  assert.deepEqual((await svc(k2)).map(s => [s.feast, s.start]), [[null, "11:00"], ["own_1", "10:00"]]);
});

await db.close();
console.log(`\n${passed} checks passed${process.exitCode ? ", some FAILED" : ""}.`);
