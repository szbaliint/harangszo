# Harangszó – notes for Claude

Catholic church map for Hungary: where and when there is Mass, confession and adoration.
Answer the owner (Bálint) in English. The app's UI text is Hungarian; code, comments and commit messages are in English.

Live: https://szbaliint.github.io/harangszo/ (map) · `plebania.html` (parishes) · `admin.html` (admin).

## Shape of the app

- **Static site, no build step.** Vanilla JS + CSS, served by GitHub Pages. `.github/workflows/pages.yml` copies an
  explicit file list into `_site/` and fills `config.js` placeholders from repo secrets. **A new page or script must be
  added to that `cp` line**, or it 404s live.
- **Backend: Supabase** (project `rlvcwytbengldqgemliu`). Postgres + RLS + RPCs; the browser uses only the publishable key.
- `index.html` + `app.js` – the public map. Map-first layout (full-screen map, bottom sheet / desktop side panel,
  nearest strip, tab bar). Google Maps when `GOOGLE_MAPS_KEY` is set (it is, live), otherwise Leaflet + CARTO tiles.
  Zoomed out, nearby churches merge into numbered circles (grid clustering in `updateMarkers`).
- `calendar.js` (`window.LitCal`) – shared by the site, admin, parish page and the Node imports: movable feasts,
  `FEASTS` (+ `FEAST_GROUPS` holyday/public), `PERIOD_INFO` seasons, `inPeriod`, `weekOk`, `everyOk`, `isHoliday`, tags.
- `admin.html` + `admin.js` – the owner's all-powerful editor: every church, suggestions, merge, access requests
  ("Hozzáférések"), per-church editors and edit history. Parish accounts opening it are sent to `plebania.html`.
- `plebania.html` + `plebania.js` – the parish portal: sign up → request access to a church → admin approves →
  week board editor in plain words, feasts, events, details, live 7-day preview. Saves through `save_church`.
- `styles.css` – shared tokens (light/dark). `replica/` holds design notes from the map-layout redesign (clean-room:
  never copy the reference app's assets, brand or copy).

## Data model (see `supabase/schema.sql`, the full current state)

- `churches`; `services` = recurring rules: `kind` (mass/confession/adoration/rorate/prayer), `days[]`, `start/end`,
  `period` (summer/winter = clock change; summer_months/winter_months = calendar; advent, christmas, lent, eastertide,
  school, holiday…), `valid` (MM-DD/MM-DD), `weeks[]` (nth week of month), `every`+`anchor` (fortnightly…), `tags[]`,
  `celebrant`, `place`/`place_church_id` (held elsewhere), `feast_skip`, `feast` (row only on that feast/group).
  `churches.feast_sunday[]` = feasts that follow the Sunday order.
- `dated_services` – times for specific dates from a parish's own weekly schedule; on those dates they replace the rules.
- `opening_hours`, `events`, `suggestions`, `staff` (admin/parish), `staff_churches`, `access_requests`, `church_edits`.
- RPCs: `public_data` (everything the map needs), `save_church`, `insert_services`, `import_church_schedule`,
  `import_dated_services`, `merge_churches`, `approve_access`.
- Order of precedence on a day (app.js `dayInfo`, plebania.js `dayList`): dated rows → a feast's own rows → a feast
  group's rows → feast_sunday (Sunday order) → regular rules (season, weeks, every, rorate only in Advent, feast_skip).

## Imports (`scripts/`, Node 22, run as GitHub Actions with `SUPABASE_URL` + `SUPABASE_SECRET_KEY`)

- `import-miserend.mjs` – all churches from the miserend.hu export (v5 SQLite with RRULEs); `lib/miserend.mjs`
  `deriveSchedule` turns occurrences back into rules. Manual, `dry_run` input.
- `import-szfvar.mjs` – Székesfehérvár diocese site. `import-osm.mjs` – church locations.
- `import-ferences.mjs` – Ferenciek tere weekly PDF → `dated_services`, daily cron. Stores the celebrant; never the
  Mass intentions or confessors' names.
- Imports never overwrite a church whose `schedule_locked` is set (parish saves always set it).
- Embeds of `services` from `churches` must name the FK: `services!services_church_id_fkey(...)` (there are two FKs).

## Rules

- Never ask for, print or commit keys. Real values live only in repo secrets; `config.js` keeps `__PLACEHOLDER__`s.
  The secret key is used only by the import workflows.
- Schema changes: add a new numbered, idempotent file in `supabase/migrations/` (safe to run twice) **and** update
  `supabase/schema.sql` to the full state. Apply live via the Supabase connector or the dashboard SQL Editor.
- Parish editors must never be able to change admin-only fields (published, importance, import keys): the
  `churches_guard` trigger enforces it — keep it in mind when adding columns.
- Test UI changes with Playwright against a local `python3 -m http.server`, mocking Supabase; test SQL with PGlite.
  `npm test` runs `tests/` (node:test + the globally installed Playwright, no dependencies; `tests/helpers/` has the
  server and the Supabase mock). Tests need network for the supabase-js and Google Fonts CDNs.
- Commit and push only when asked.
