# Harangszó – notes for Claude

Catholic church map for Hungary: where and when there is Mass, confession and adoration.
Answer the owner (Bálint) in English. The app's UI text is Hungarian; code, comments and commit messages are in English.

Live: https://szbaliint.github.io/harangszo/ (map) · `plebania.html` (parishes) · `admin.html` (admin).

## Shape of the app

- **Static site, no build step.** Vanilla JS + CSS, served by GitHub Pages. `.github/workflows/pages.yml` copies an
  explicit file list into `_site/` and fills `config.js` placeholders from repo secrets. **A new page or script must be
  added to that `cp` line**, or it 404s live.
- **Backend: Supabase** (project `rlvcwytbengldqgemliu`). Postgres + RLS + RPCs; the browser uses only the publishable key.
- `index.html` + `app.js` – the public app, "church first" (brief: `.impeccable/surfaces/index-html.md`). Tab bar
  **Most · Térkép · Mentett** (desktop: a 420px white column left with the tabs as a segmented row, the map right).
  **Most** (home) opens on the nearest church with a Mass still to come: its photo edge to edge (credit in the
  corner; no photo = same layout without it, never a placeholder), the day line, the time at 64px with the kind in
  red, name, address · distance, Útvonal / Heti rend / Honlap, then "Utána a közelben" rows. **Térkép**: grey map,
  black time pins (the next one red), search field and a bottom panel; zoomed out, churches merge into numbered
  circles (grid clustering in `updateMarkers`). **Mentett**: saved churches (localStorage). "Keresés" opens a
  full-height search panel with filters (it counts as tab "list"). The church page: photo header, 7-day strip, week.
  Google Maps when `GOOGLE_MAPS_KEY` is set (it is, live), otherwise Leaflet + CARTO tiles.
- Church photos (migration 013): `churches.photo_url/photo_credit/photo_source ('commons'|'parish')/photo_page`, in
  `public_data`. Commons photos come from `scripts/import-photos.mjs` (workflow "Import church photos from Wikimedia
  Commons", manual, `dry_run`; free licences only, credit "Fotó: <szerző> · <licenc> · Wikimedia Commons"; never
  replaces a parish photo). Parishes and the admin upload their own in Adatok → Fotó (`church-photo.js`,
  `window.ChurchPhoto`: ≤1600px JPEG → public bucket `church-photos` at `<church_id>/<timestamp>.jpg` →
  `set_church_photo(cid, url|null)`; a parish can replace but not remove a Commons photo). The map loads Commons
  photos straight from upload.wikimedia.org (named in jogi.html's privacy notice).
- `calendar.js` (`window.LitCal`) – shared by the site, admin, parish page and the Node imports: movable feasts,
  `FEASTS` (+ `FEAST_GROUPS` holyday/public), `PERIOD_INFO` seasons, `inPeriod`, `weekOk`, `everyOk`, `isHoliday`, tags.
- `admin.html` + `admin.js` – the owner's all-powerful editor (laptop first: rail · church list · church): every
  church, suggestions, merge, access requests ("Hozzáférések"), per-church editors, edit history, photo, Statisztika.
  Parish accounts opening it are sent to `plebania.html`.
- `plebania.html` + `plebania.js` – the parish portal (phone first, sections in a bottom tab bar): sign up → request
  access to a church → admin approves → week board editor in plain words, feasts, events, details and photo, live
  7-day preview. Saves through `save_church` (the photo is saved at once, outside the save bar).
- `jogi.html` – impresszum, privacy notice, terms (operator name/contact are still `[PLACEHOLDER]`s).
- PWA (map only): `manifest.webmanifest`, `sw.js` (precaches the map's shell; `__BUILD__` is stamped with the commit
  by pages.yml, so each deploy offers "Frissítés"), `icons/` (a white church bell on ink; PNGs rendered from
  `bell.svg` by `icons/render.mjs`).
- `analytics.js` (`window.Track`) – anonymous usage counters from the map (no cookies or ids; off with Do Not Track,
  in automated browsers unless `?track=1`, and on a device where an admin opened admin.html). Admin shows them under
  "Statisztika". A new event name or key must also be allowed in the `track()` SQL function (014 added tab "most").
- `schedule-editor.js` (`window.ScheduleEditor`) – the week board + question-style time editor shared by the parish
  portal and admin (`admin: true` adds the raw "Haladó" fields).
- `styles.css` – the one design system for every page: white ground, ink `#111`, greys `#555`/`#767676`, hairlines
  `#e6e6e6`, one red `#b4232a` that only means "the next one / applies now" (and errors), the platform font (no web
  fonts, no monospace), sizes 13/15/17/22 (+40/64 for big times), radius 10 for buttons and fields, 0 for rows; light
  and dark tokens; the `ui-` components, the week board (`se-`) and the photo block (`cp-`). Pages keep only their
  layout in their own `<style>`. Product brief: `PRODUCT.md`; surface brief: `.impeccable/surfaces/index-html.md`.
  `replica/` holds clean-room notes from an earlier layout study (never copy the reference app's assets, brand or copy).

## Data model (see `supabase/schema.sql`, the full current state)

- `churches`; `services` = recurring rules: `kind` (mass/confession/adoration/rorate/prayer), `days[]`, `start/end`,
  `period` (summer/winter = clock change; summer_months/winter_months = calendar; advent, christmas, lent, eastertide,
  school, holiday…), `valid` (MM-DD/MM-DD), `weeks[]` (nth week of month), `every`+`anchor` (fortnightly…), `tags[]`,
  `celebrant`, `place`/`place_church_id` (held elsewhere), `feast_skip`, `feast` (row only on that feast/group).
  `churches.feast_sunday[]` = feasts that follow the Sunday order.
- `dated_services` – times for specific dates from a parish's own weekly schedule; on those dates they replace the rules.
- `opening_hours`, `events`, `suggestions`, `staff` (admin/parish), `staff_churches`, `access_requests`, `church_edits`.
- `analytics_daily` – anonymous counters per (day, event, key), written only by `track()`, read only by
  `analytics_report()` (admins). Never add a visitor id, IP address or cookie to it.
- RPCs: `public_data` (everything the map needs), `save_church`, `insert_services`, `import_church_schedule`,
  `import_dated_services`, `merge_churches`, `approve_access`, `track`, `analytics_report`, `set_church_photo`,
  `import_church_photos` (secret key).
- Order of precedence on a day (app.js `dayInfo`, plebania.js `dayList`): dated rows → a feast's own rows → a feast
  group's rows → feast_sunday (Sunday order) → regular rules (season, weeks, every, rorate only in Advent, feast_skip).

## Imports (`scripts/`, Node 22, run as GitHub Actions with `SUPABASE_URL` + `SUPABASE_SECRET_KEY`)

- `import-miserend.mjs` – all churches from the miserend.hu export (v5 SQLite with RRULEs); `lib/miserend.mjs`
  `deriveSchedule` turns occurrences back into rules. Manual, `dry_run` input.
- `import-szfvar.mjs` – Székesfehérvár diocese site. `import-osm.mjs` – church locations.
- `import-photos.mjs` – free Wikimedia Commons photos for OSM churches (OSM tags / Wikidata P18), manual, `dry_run`.
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
  server and the Supabase mock, which also fakes Storage). Tests need network for the supabase-js CDN.
  `tests/sql/*.pglite.mjs` check migrations against PGlite (not in `npm test`; see their headers).
- Commit and push only when asked.
