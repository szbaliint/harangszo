# Harangszó – notes for Claude

Catholic church map for Hungary: where and when there is Mass, confession and adoration.
Answer the owner (Bálint) in English. The app's UI text is Hungarian; code, comments and commit messages are in English.

Live: https://szbaliint.github.io/harangszo/ (map) · `plebania.html` (parishes) · `admin.html` (admin).

## Shape of the app

- **Static site, no build step.** Vanilla JS + CSS, served by GitHub Pages. `.github/workflows/pages.yml` copies an
  explicit file list into `_site/` and fills `config.js` placeholders from repo secrets. **A new page or script must be
  added to that `cp` line**, or it 404s live.
- **Backend: Supabase** (project `rlvcwytbengldqgemliu`). Postgres + RLS + RPCs; the browser uses only the publishable key.
- `index.html` + `app.js` – the public app, **"Indulások"**: nearby Masses and confessions as departures (brief:
  `.impeccable/surfaces/index-html.md`; approved sketch `.impeccable/mocks/decision/n-board.html`). Tab bar
  **Indulások · Térkép · Keresés · Mentett** (`data-tab` most/map/list/saved, the keys `track()` knows; desktop: a 420px
  column left with the tabs in its navy top bar, the map right). **Indulások** (home): navy header (title, "Szerda,
  nov. 25. · 17:48 · a helyzeted|<town>", the church-year line `litLine`: liturgical week + next Sunday's name
  `sundayName`, segmented Mind / Mise / Gyónás `S.nk`); the amber **pass** = `departures().pass`, the earliest Mass or
  confession still reachable on foot (start − walk ≥ now; walk at 5 km/h, only up to 30 min), else the nearest one to
  come, else one going on; its photo with the credit, "Indulj 17:58"/"Következő"/"Most tart", Útvonal. Then the
  **board**: the nearest 40 churches within 25 km, today's items still to come or going on, ranked by start time (a
  time twice at one church = one row): time | church + kind ("gyónás 18:15-ig") | walk ("7 p", km beyond 30 min) |
  status chip (`statusOf`: "most tart" red only while it goes on; "indulj HH:MM" amber only from the visitor's own
  position and within 15 min; grey "N perc" / "HH:MM-kor" / "1 óra 12 p"). Rows are kept by key and rerank by FLIP
  (`syncRows`, 350ms on `--spring`) each minute; a row whose status changed flashes amber and holds it until the next
  tap or key. The position is asked only from "Saját helyzetem" (header pill, map control), never on load; otherwise
  the chosen town, said in the header and the "Kiindulópont" select. **Térkép**: grey map, navy time pins (amber
  for the pass's church, only from the visitor's own position), a search field (opens Keresés), the mini pass
  (`#mapcard`, amber when it shows the pass); zoomed out, churches merge into numbered circles (grid clustering in
  `updateMarkers`). **Keresés**: field, day, Mind/Mise/Gyónás, "További szűrők" (origin, Mass type, open now, events,
  Rorate), results as board rows. **Mentett**: saved churches (localStorage) as board rows. The **church page**: navy
  band with Vissza, the pass card (photo + credit, name, address, labelled fields Idő · Alkalom · Táv · Séta, status
  and notes), Útvonal + Hívás / Honlap / Mentés / Megosztás / Javítás, the 7-day strip and that day's times, folds
  (week timetable, dated week, feasts incl. own feasts and Rorate, events, the parish's note), the source/honesty line.
  Motion: the church page enters from the right and leaves the same way (view transitions), tabs cross-fade, press
  feedback on pointer-down; a new pass (its `sig` changed, not the minute's update) comes up 8px into place (220ms,
  `arrive()`); a tapped day's times slide in 12px from the side of travel (200ms); `.ui-fold` glides open and shut
  where the browser has `::details-content` + `interpolate-size`; reduced motion = 150ms cross-fades only.
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
- `admin.html` + `admin.js` – the owner's all-powerful editor (laptop first: navy rail · church list · church): every
  church, suggestions, merge, access requests ("Hozzáférések"), per-church editors, edit history, photo, Statisztika.
  The list is a board (TEMPLOM / IDŐPONT labels, name 800, one grey `ui-meta` line with problems first in red, the
  count of times; the open church is the navy row); sign-in screens get a navy band (`band()`). Parish accounts
  opening it are sent to `plebania.html`.
- `plebania.html` + `plebania.js` – the parish portal (phone first): a navy header with the screen's title or the
  church (name, state, on phones the Szerkesztés / Így látják a hívek switch) and the sections (a bottom tab bar with
  line icons on phones, navy tabs in the header from 980px): sign up → request access to a church → admin approves →
  week board editor in plain words, feasts, events, details and photo, live 7-day preview (a NAP / IDŐPONTOK board).
  Saves through `save_church` (the photo is saved at once, outside the save bar).
- **Unsaved changes are amber** (the editors' signature move, portal and admin): what differs from the church as last
  saved (`P.base` / `A.base` snapshots; `data-chg` rows and boxes get `.chg` = pale amber `--flash`), the week board's
  changed times (amber) and their day rows (`ScheduleEditor.mount({ baseline })`), an amber dot on the tab that holds
  them, and the amber save bar "N nem mentett változás" (red with the reason when a save fails). Undoing every change
  hides the bar. A save lets the amber fade (`ScheduleEditor.settle` → `.chg-out`, 600ms; none under reduced motion).
- `jogi.html` – impresszum, privacy notice, terms (operator name/contact are still `[PLACEHOLDER]`s); a navy header
  with Vissza, then hairline sections.
- PWA (map only): `manifest.webmanifest`, `sw.js` (precaches the map's shell; `__BUILD__` is stamped with the commit
  by pages.yml, so each deploy offers "Frissítés"; navy theme colour, as every page's `theme-color`), `icons/` (a white
  church bell on the board's navy `#13233f`; PNGs rendered from `bell.svg` by `icons/render.mjs`).
- `analytics.js` (`window.Track`) – anonymous usage counters from the map (no cookies or ids; off with Do Not Track,
  in automated browsers unless `?track=1`, and on a device where an admin opened admin.html). Admin shows them under
  "Statisztika". A new event name or key must also be allowed in the `track()` SQL function (014 added tab "most";
  Indulások is "most", Keresés is "list").
- `schedule-editor.js` (`window.ScheduleEditor`) – the week board (a timetable: NAP / IDŐPONTOK labels, day name in a
  grey left column, times as quiet text buttons "07:00 mise" with the time 800, "+ időpont"; one time per 44px line on
  narrow boards) + question-style time editor shared by the parish portal and admin (`admin: true` adds the raw
  "Haladó" fields); `baseline` / `setBaseline()` / `settle()` hold unsaved changes in amber.
- `styles.css` – the one design system for every page: a navy board (`--board` #13233f, `--board-2` #1d3257) over
  white rows, ink `#14213d`, greys `#5d6779`/`#6b7488`, hairlines `#e6e9ef`; ONE amber `#ffb703` (`--amber`, dark text
  on it) that only marks "leave now" and a changed row; red `--now` `#d33a2c` (#e5483a darkened for AA) only for "most
  tart" and errors; dark mode = a navy-black board with the same amber and red. Cards 18px, segmented controls and
  fields 12px, buttons and status chips are pills; one soft shadow (`--lift`) for floating things. The `ui-`
  components (incl. the amber `ui-savebar`), the week board (`se-`) and the photo block (`cp-`) are shared with the
  portal, admin and jogi.html, which keep only their layout in their own `<style>`. Type: **Overpass** for everything,
  tabular figures, 800 for times, names and headings, 700 labels/controls, 600 meta, 400 text, on every page
  (`tests/helpers/type-check.mjs`); small uppercase column labels; no eyebrow/kicker over a heading. Overpass is **self-hosted** in
  `fonts/` (variable woff2, latin + latin-ext, `OFL-Overpass.txt`; no Google Fonts request; its "·" was re-classed from
  mark to base glyph with fontTools so " · " keeps its width); `index.html` preloads the latin file and `sw.js` keeps
  both in its own font cache (bump `FONT_CACHE`, now `harangszo-fonts-2`, when a file changes). Product brief:
  `PRODUCT.md`; surface brief: `.impeccable/surfaces/index-html.md`. `tests/shots.mjs <dir>` saves review
  screenshots (fixed clock, the fake Supabase, `tests/fixtures/board-churches.json`).
  `replica/` holds clean-room notes from an earlier layout study (never copy the reference app's assets, brand or copy).

## Data model (see `supabase/schema.sql`, the full current state)

- `churches`; `services` = recurring rules: `kind` (mass/confession/adoration/rorate/prayer), `days[]`, `start/end`,
  `period` (summer/winter = clock change; summer_months/winter_months = calendar; advent, christmas, lent, eastertide,
  school, holiday…), `valid` (MM-DD/MM-DD), `weeks[]` (nth week of month), `every`+`anchor` (fortnightly…), `tags[]`,
  `celebrant`, `place`/`place_church_id` (held elsewhere), `feast_skip`, `feast` (row only on that feast/group).
  `churches.feast_sunday[]` = feasts that follow the Sunday order.
- `churches.own_feasts` (migration 015) = the church's own feasts, a fixed date every year:
  `[{key: "own_1", name: "Szent Anna búcsú", md: "07-26"}]` (≤10, checked by `own_feasts_ok`; 02-29 only in leap years).
  Their keys work like built-in feast keys (`feast_sunday`, `services.feast`); editable by parishes; `LitCal.ownFeastsOn`.
- `dated_services` – times for specific dates from a parish's own weekly schedule; on those dates they replace the rules.
- `opening_hours`, `events`, `suggestions`, `staff` (admin/parish), `staff_churches`, `access_requests`, `church_edits`.
- `analytics_daily` – anonymous counters per (day, event, key), written only by `track()`, read only by
  `analytics_report()` (admins). Never add a visitor id, IP address or cookie to it.
- RPCs: `public_data` (everything the map needs), `save_church`, `insert_services`, `import_church_schedule`,
  `import_dated_services`, `merge_churches`, `approve_access`, `track`, `analytics_report`, `set_church_photo`,
  `import_church_photos` (secret key).
- Order of precedence on a day (app.js `dayInfo`, plebania.js `dayList`): dated rows → the church's own feast (its rows,
  or its Sunday order) → a feast's own rows → a feast group's rows → feast_sunday (Sunday order) → regular rules (season, weeks, every, rorate only in Advent, feast_skip).

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
