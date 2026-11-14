// Migration 013 (church photos) against a real Postgres (PGlite, in memory): columns, public_data(), the
// churches_guard photo rules, set_church_photo(), import_church_photos() and the storage policies.
//
// Not part of `npm test`: it needs @electric-sql/pglite, which is not a repo dependency. Run it with a directory
// that has PGlite installed (outside the repo):
//   mkdir -p /tmp/pg && (cd /tmp/pg && npm init -y >/dev/null && npm i @electric-sql/pglite)
//   PGLITE_DIR=/tmp/pg node tests/sql/photos.pglite.mjs
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
const MIGRATION = read("supabase/migrations/013_photos.sql");
const STUBS = `
  create role anon; create role authenticated; create role service_role bypassrls;
  -- as on Supabase: the secret key's role may use every table
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

// ── 1. The migration runs on the state before it (twice), and schema.sql (with 013 merged in) runs twice too. ──
console.log("Runs twice");
let oldSchema = null;
try { oldSchema = execFileSync("git", ["-C", ROOT, "show", "91dedf5:supabase/schema.sql"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { }
if (oldSchema) {
  await ok("013 twice on the schema before 013", async () => {
    const db = await fresh(oldSchema);
    await db.exec(MIGRATION); await db.exec(MIGRATION);
    const cols = (await db.query(`select column_name from information_schema.columns where table_name = 'churches' and column_name like 'photo%' order by 1`)).rows.map(r => r.column_name);
    assert.deepEqual(cols, ["photo_checked_at", "photo_credit", "photo_page", "photo_source", "photo_url"]);
    await db.close();
  });
} else console.log("  (skipped: the pre-013 schema is not in this git checkout)");

const db = await fresh(read("supabase/schema.sql"));
await ok("schema.sql again, then 013 twice on top", async () => { await db.exec(read("supabase/schema.sql")); await db.exec(MIGRATION); await db.exec(MIGRATION); });

// ── Fixtures ──
const ADMIN = "00000000-0000-0000-0000-00000000000a", PAR = "00000000-0000-0000-0000-00000000000b";
const PREFIX = "https://rlvcwytbengldqgemliu.supabase.co/storage/v1/object/public/church-photos/";
const COMMONS = "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/1000px-X.jpg";
await db.exec(`
  insert into auth.users values ('${ADMIN}'), ('${PAR}');
  insert into public.staff (user_id, role, display_name) values ('${ADMIN}', 'admin', 'Admin'), ('${PAR}', 'parish', 'Szent Anna plébánia');
  insert into public.churches (id, name, city, lat, lon) values
    (1, 'Szent Anna', 'Budapest', 47.5, 19.03),       -- the parish's church, no photo
    (2, 'Másik', 'Eger', 47.9, 20.3),                 -- not the parish's, Commons photo
    (3, 'Filia', 'Vác', 47.7, 19.1),                  -- the parish's, Commons photo
    (4, 'Üres', 'Győr', 47.6, 17.6);                  -- nobody's, no photo
  update public.churches set photo_url = '${COMMONS}', photo_credit = 'Fotó: Valaki · CC BY-SA 4.0 · Wikimedia Commons',
    photo_source = 'commons', photo_page = 'https://commons.wikimedia.org/wiki/File:X.jpg' where id in (2, 3);
  insert into public.staff_churches values ('${PAR}', 1), ('${PAR}', 3);
`);
const q = async (sql, params) => (await db.query(sql, params)).rows;
const row = async id => (await q(`select photo_url, photo_credit, photo_source, photo_page, photo_checked_at, updated_at from public.churches where id = $1`, [id]))[0];
// Run fn as a signed-in user (role authenticated, auth.uid() = uid), as anon, or as the import's service_role.
async function as(role, uid, fn) {
  await db.exec(`set test.uid = '${uid || ""}'; set role ${role}`);
  try { return await fn(); } finally { await db.exec("reset role; set test.uid = ''"); }
}
const parish = fn => as("authenticated", PAR, fn), admin = fn => as("authenticated", ADMIN, fn), service = fn => as("service_role", "", fn);
const rejects = async (p, re) => { await assert.rejects(p, re); };

// ── 2. public_data ──
console.log("public_data()");
await ok("has photo_url and photo_credit where set, nothing where not", async () => {
  const data = (await as("anon", "", () => q("select public.public_data() d")))[0].d;
  const c2 = data.find(c => c.id === 2), c1 = data.find(c => c.id === 1);
  assert.equal(c2.photo_url, COMMONS);
  assert.equal(c2.photo_credit, "Fotó: Valaki · CC BY-SA 4.0 · Wikimedia Commons");
  assert.equal(c2.photo_page, "https://commons.wikimedia.org/wiki/File:X.jpg"); assert.equal(c2.photo_source, undefined);
  assert.equal(c2.photo_checked_at, undefined);
  assert.ok(!("photo_url" in c1) && !("photo_credit" in c1) && !("photo_page" in c1));
  assert.deepEqual(Object.keys(c1).sort(), ["address", "city", "id", "imp", "lat", "lon", "name", "rite"]);
});

// ── 3. Direct updates (PostgREST PATCH) by a parish editor ──
console.log("churches_guard (direct updates)");
await ok("parish cannot set a Commons photo on its own church", async () => {
  await parish(() => q(`update public.churches set photo_url = $1, photo_credit = 'x', photo_source = 'commons', photo_page = 'p' where id = 1`, [COMMONS]));
  const r = await row(1); assert.equal(r.photo_url, null); assert.equal(r.photo_source, null);
});
await ok("parish cannot put an outside link as its 'parish' photo", async () => {
  await parish(() => q(`update public.churches set photo_url = 'https://example.com/a.jpg', photo_source = 'parish' where id = 1`));
  assert.equal((await row(1)).photo_url, null);
});
await ok("parish cannot use another church's folder", async () => {
  await parish(() => q(`update public.churches set photo_url = $1, photo_source = 'parish' where id = 1`, [PREFIX + "2/a.jpg"]));
  assert.equal((await row(1)).photo_url, null);
});
await ok("parish can set its own uploaded photo; credit and page are fixed", async () => {
  await parish(() => q(`update public.churches set photo_url = $1, photo_source = 'parish', photo_credit = 'Fotó: bárki', photo_page = 'https://x' where id = 1`, [PREFIX + "1/front.jpg"]));
  const r = await row(1);
  assert.deepEqual([r.photo_url, r.photo_source, r.photo_credit, r.photo_page], [PREFIX + "1/front.jpg", "parish", "Fotó: a plébánia", null]);
  const c1 = (await as("anon", "", () => q("select public.public_data() d")))[0].d.find(c => c.id === 1);
  assert.deepEqual([c1.photo_url, c1.photo_credit, "photo_page" in c1], [PREFIX + "1/front.jpg", "Fotó: a plébánia", false]);
});
await ok("parish cannot relabel its photo as Commons", async () => {
  await parish(() => q(`update public.churches set photo_source = 'commons' where id = 1`));
  assert.equal((await row(1)).photo_source, "parish");
});
await ok("parish cannot touch another church at all (RLS)", async () => {
  const res = await parish(() => db.query(`update public.churches set photo_url = null, photo_source = null where id = 2`));
  assert.equal(res.affectedRows, 0); assert.equal((await row(2)).photo_url, COMMONS);
});
await ok("parish cannot remove a Commons photo, nor stamp photo_checked_at", async () => {
  await parish(() => q(`update public.churches set photo_url = null, photo_credit = null, photo_source = null, photo_page = null, photo_checked_at = now() where id = 3`));
  const r = await row(3); assert.equal(r.photo_source, "commons"); assert.equal(r.photo_url, COMMONS); assert.equal(r.photo_checked_at, null);
});
await ok("save_church by the parish keeps the photo", async () => {
  await parish(() => q(`select public.save_church($1::jsonb)`, [JSON.stringify({ id: 1, name: "Szent Anna", city: "Budapest", lat: 47.5, lon: 19.03 })]));
  assert.equal((await row(1)).photo_url, PREFIX + "1/front.jpg");
});
await ok("parish can remove its own photo", async () => {
  await parish(() => q(`update public.churches set photo_url = null where id = 1`));
  const r = await row(1); assert.deepEqual([r.photo_url, r.photo_credit, r.photo_source, r.photo_page], [null, null, null, null]);
});
await ok("admin can set a Commons photo directly", async () => {
  await admin(() => q(`update public.churches set photo_url = $1, photo_credit = 'Fotó: A · CC0 · Wikimedia Commons', photo_source = 'commons' where id = 4`, [COMMONS]));
  assert.equal((await row(4)).photo_source, "commons");
});
await ok("photo_source must be commons, parish or null", async () => {
  await rejects(db.query(`update public.churches set photo_source = 'flickr' where id = 4`), /churches_photo_check/);
});

// ── 4. set_church_photo ──
console.log("set_church_photo()");
const setPhoto = (cid, url) => q(`select public.set_church_photo($1, $2)`, [cid, url]);
await ok("accepts its own church's storage URL", async () => {
  await parish(() => setPhoto(1, PREFIX + "1/templom-2026.webp?v=3"));
  const r = await row(1); assert.deepEqual([r.photo_url, r.photo_credit, r.photo_source, r.photo_page], [PREFIX + "1/templom-2026.webp?v=3", "Fotó: a plébánia", "parish", null]);
});
for (const [what, cid, url] of [
  ["another church's folder", 1, PREFIX + "2/a.jpg"], ["a folder whose id only starts the same", 1, PREFIX + "11/a.jpg"],
  ["an outside URL", 1, "https://example.com/1/a.jpg"], ["a sub-path", 1, PREFIX + "1/../2/a.jpg"], ["a nested folder", 1, PREFIX + "1/x/a.jpg"],
  ["the bare folder", 1, PREFIX + "1/"], ["another bucket", 1, PREFIX.replace("church-photos", "other") + "1/a.jpg"],
  ["http instead of https", 1, PREFIX.replace("https:", "http:") + "1/a.jpg"]]) {
  await ok("refuses " + what, () => rejects(parish(() => setPhoto(cid, url)), /saját tárhelyéről/));
}
await ok("refuses a church the parish does not edit", () => rejects(parish(() => setPhoto(2, PREFIX + "2/a.jpg")), /Nincs jogod/));
await ok("refuses a signed-out caller (anon has no execute right)", () => rejects(as("anon", "", () => setPhoto(1, PREFIX + "1/a.jpg")), /permission denied/));
await ok("refuses an authenticated user who is not staff", () => rejects(as("authenticated", "00000000-0000-0000-0000-0000000000ff", () => setPhoto(1, PREFIX + "1/a.jpg")), /Nincs jogod/));
await ok("may replace a Commons photo with its own", async () => {
  await parish(() => setPhoto(3, PREFIX + "3/a.jpg")); assert.equal((await row(3)).photo_source, "parish");
});
await ok("null removes the parish's photo", async () => {
  await parish(() => setPhoto(3, null)); const r = await row(3); assert.equal(r.photo_url, null); assert.equal(r.photo_source, null);
});
await ok("null does not remove a Commons photo (parish), but does for an admin", async () => {
  await db.exec(`update public.churches set photo_url = '${COMMONS}', photo_source = 'commons', photo_credit = 'c' where id = 3`);
  await rejects(parish(() => setPhoto(3, null)), /Commons/);
  assert.equal((await row(3)).photo_source, "commons");
  await admin(() => setPhoto(3, null)); assert.equal((await row(3)).photo_source, null);
});

// ── 5. import_church_photos (photo import, service_role) ──
console.log("import_church_photos()");
await ok("only service_role may run it", () => rejects(parish(() => q(`select public.import_church_photos('[]')`)), /permission denied/));
await ok("sets Commons photos, never touches a parish photo, clears a vanished Commons photo", async () => {
  // 1: parish photo (set above), 2: Commons photo, 3: none, 4: Commons (set by admin)
  const rows = [
    { id: 1, url: COMMONS, credit: "Fotó: Import · CC0 · Wikimedia Commons", page: "https://commons.wikimedia.org/wiki/File:Y.jpg" },
    { id: 2, url: null },
    { id: 3, url: COMMONS, credit: "Fotó: Import · CC BY 4.0 · Wikimedia Commons", page: "https://commons.wikimedia.org/wiki/File:Y.jpg" },
  ];
  const n = (await service(() => q(`select public.import_church_photos($1::jsonb) n`, [JSON.stringify(rows)])))[0].n;
  assert.equal(n, 2);
  const r1 = await row(1), r2 = await row(2), r3 = await row(3);
  assert.equal(r1.photo_source, "parish"); assert.equal(r1.photo_checked_at, null);
  assert.deepEqual([r2.photo_url, r2.photo_credit, r2.photo_source, r2.photo_page], [null, null, null, null]); assert.ok(r2.photo_checked_at);
  assert.deepEqual([r3.photo_url, r3.photo_credit, r3.photo_source], [COMMONS, "Fotó: Import · CC BY 4.0 · Wikimedia Commons", "commons"]);
});
await ok("a check that finds the same photo stamps photo_checked_at but not updated_at", async () => {
  await db.exec(`update public.churches set photo_checked_at = now() - interval '30 days', updated_at = now() - interval '30 days' where id = 3`);
  const before = await row(3);
  const n = (await service(() => q(`select public.import_church_photos($1::jsonb) n`, [JSON.stringify([{ id: 3, url: COMMONS, credit: "Fotó: Import · CC BY 4.0 · Wikimedia Commons", page: "https://commons.wikimedia.org/wiki/File:Y.jpg" }])])))[0].n;
  const after = await row(3);
  assert.equal(n, 0);
  assert.ok(after.photo_checked_at > before.photo_checked_at);
  assert.equal(after.updated_at.getTime(), before.updated_at.getTime());
});
await ok("ordinary edits still bump updated_at", async () => {
  const before = await row(4);
  await db.exec(`update public.churches set name = 'Üres templom' where id = 4`);
  assert.ok((await row(4)).updated_at > before.updated_at);
});

// ── 6. Storage policies ──
console.log("storage.objects policies");
const upload = (bucket, name) => q(`insert into storage.objects (bucket_id, name) values ($1, $2)`, [bucket, name]);
await ok("bucket church-photos exists and is public", async () => {
  const b = (await q(`select public, allowed_mime_types from storage.buckets where id = 'church-photos'`))[0];
  assert.equal(b.public, true); assert.deepEqual(b.allowed_mime_types, ["image/jpeg", "image/png", "image/webp"]);
});
await db.exec(`insert into storage.buckets (id, name) values ('other', 'other')`);
await ok("parish may upload into its own church's folder", () => parish(() => upload("church-photos", "1/front.jpg")));
for (const [what, bucket, name] of [["another church's folder", "church-photos", "2/a.jpg"], ["a non-numeric folder", "church-photos", "x/a.jpg"],
  ["the bucket root", "church-photos", "a.jpg"], ["a nested path", "church-photos", "1/x/a.jpg"], ["another bucket", "other", "1/a.jpg"]]) {
  await ok("parish may not upload to " + what, () => rejects(parish(() => upload(bucket, name)), /row-level security/));
}
await ok("anon may not upload", () => rejects(as("anon", "", () => upload("church-photos", "1/b.jpg")), /permission denied|row-level security/));
await ok("parish sees, renames and deletes only its own files", async () => {
  await admin(() => upload("church-photos", "2/a.jpg"));
  const seen = await parish(() => q(`select name from storage.objects order by name`));
  assert.deepEqual(seen.map(r => r.name), ["1/front.jpg"]);
  await rejects(parish(() => q(`update storage.objects set name = '2/front.jpg' where name = '1/front.jpg'`)), /row-level security/);
  const del2 = await parish(() => db.query(`delete from storage.objects where name = '2/a.jpg'`));
  assert.equal(del2.affectedRows, 0);
  const del1 = await parish(() => db.query(`delete from storage.objects where name = '1/front.jpg'`));
  assert.equal(del1.affectedRows, 1);
});

await db.close();
console.log(`\n${passed} checks passed${process.exitCode ? ", some FAILED" : ""}.`);
