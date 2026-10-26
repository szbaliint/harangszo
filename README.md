# Harangszó

Katolikus templomok térképe Magyarországon: misék, gyóntatás, nyitvatartás, események.

A map of Catholic churches in Hungary with Mass and confession times, opening hours and events.

- Public site: https://szbaliint.github.io/harangszo/
- Editor panel: https://szbaliint.github.io/harangszo/admin.html

## How it fits together

| Part | What it does |
|------|--------------|
| `index.html`, `app.js`, `styles.css` | Public map and list. Reads everything in one call (`public_data`) and sends corrections to the database. |
| `admin.html`, `admin.js` | Editor panel: log in, edit churches, opening hours, Masses, confession, adoration, events; approve or reject corrections. |
| `supabase/schema.sql` | Database tables, access rules and functions. |
| `scripts/import-osm.mjs` | Imports Catholic churches in Hungary from OpenStreetMap. |
| `.github/workflows/pages.yml` | Publishes the site and fills `config.js` from repository secrets. |
| `.github/workflows/import-osm.yml` | Runs the OpenStreetMap import on demand. |
| `calendar.js` | Liturgical calendar: Easter and feast dates, Advent, summer time. |
| `data.js` | Sample data, used only when no database is configured. |

Without a database the site shows the 21 sample churches. Without a Google Maps key it uses OpenStreetMap.

## Setting up the database (once)

### 1. Create the Supabase project
1. Sign up at [supabase.com](https://supabase.com) and create a project (region: Central EU / Frankfurt is closest).
2. **SQL Editor → New query**: paste all of `supabase/schema.sql` and click **Run**.
3. **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up", so only accounts you create can log in.
4. **Authentication → Users → Add user → Create new user**: your e-mail and a strong password.

### 2. Add the repository secrets
In this repo: **Settings → Secrets and variables → Actions → New repository secret**. Values are in Supabase under **Project Settings → API Keys** (and the project URL under **Connect**).

| Secret | Value | Used by |
|--------|-------|---------|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` | site, admin, import |
| `SUPABASE_PUBLISHABLE_KEY` | the **publishable** key (`sb_publishable_…`) | site, admin (public by design; the access rules protect the data) |
| `SUPABASE_SECRET_KEY` | the **secret** key (`sb_secret_…`) | import only. Never put it anywhere else. |
| `GOOGLE_MAPS_KEY` | optional, see below | site |

Then re-run **Deploy to GitHub Pages** in the Actions tab.

### 3. Make yourself an administrator
Open `admin.html` and log in. The page shows your user id and a ready-made SQL line; run it in the Supabase SQL Editor, then refresh. It looks like:

```sql
insert into public.staff (user_id, role, display_name)
values ('<your user id>', 'admin', 'Bálint');
```

### 4. Import the churches
**Actions → Import churches from OpenStreetMap → Run workflow.** Tick "Only count" first if you want a dry run. The import only adds churches that are missing, so it is safe to run again later to pick up new ones; it never changes or deletes churches already in the database.

## Updating an existing database

Run the migrations you haven't run yet, in order, in the SQL Editor. Each is safe to run twice. A fresh install only needs `schema.sql`.

| File | Adds |
|------|------|
| `supabase/migrations/002_seasons_feasts_rorate.sql` | summer/winter schedules, feast-day schedules, Rorate |
| `supabase/migrations/003_importance.sql` | importance scores, so the map shows notable churches first |
| `supabase/migrations/004_admin_list.sql` | church overview used by the admin panel's filters |
| `supabase/migrations/005_schedule_sources.sql` | schedule notes, sources and locking, for diocesan imports |

After 003, run the **Import churches from OpenStreetMap** workflow once: it fills in the importance scores of churches already in the database (and adds any new ones).

## How the map stays fast

The map never draws every church. It shows the most important churches in the current view (about 40–180, depending on screen size); zooming in reveals smaller ones, and from street level everything shows. Importance comes from OpenStreetMap at import time (cathedral, basilica, pilgrimage church, Wikipedia entry, city size; chapels rank lower), plus a bonus for churches whose times are entered. Editors can override it per church with "Kiemelés a térképen".

## Schedules: seasons, feasts, Rorate

- **Summer/winter:** a regular time row can be marked "Csak nyáron" or "Csak télen". Summer means summer time (last Sunday of March to last Sunday of October). Rows that never change stay "Egész évben".
- **Ünnepi miserend:** per church and feast, either "Vasárnapi miserend szerint" or custom times. Custom times replace that day's regular times. Easter-based dates are calculated for every year (`calendar.js`); Ascension and Corpus Christi fall on Sunday in Hungary.
- **Rorate:** a row type that only appears during Advent (first Sunday of Advent to 24 December). The public map shows a "Rorate" filter in Advent.
- Midnight Mass is entered as 00:00 and shown as 24:00 at the end of the day.
- Times are always 24-hour (17:30); the editor accepts 1730, 17.30 or 17,30 too.

## Importing the Székesfehérvár diocese schedule

**Actions → Import Székesfehérvár diocese schedule → Run workflow.** Leave "Only show what would happen" ticked the first time: the run's summary page lists every church on [the diocese's schedule page](https://www.szfvar.katolikus.hu/adattar/miserend) with what would happen to it. Then run it again with the box unticked.

- Each church is matched to the database by its settlement's location and its name (e.g. "Szentháromság" ↔ "Szentháromság-templom"). Churches not found are added at the settlement centre and marked "hely pontosítandó"; find them in the admin panel with Egyéb → "Hely pontosítandó".
- Only regular times (and feast rows the page names, e.g. Pünkösdhétfő) are replaced. Opening hours, events and feast schedules set by hand stay.
- Churches whose times were entered by hand are skipped (tick "Also overwrite hand-entered times" to include them). Churches marked "Kézzel ellenőrzött miserend" are never touched; editing an imported church's times in the admin panel ticks this automatically.
- The page's notes appear on the public site as "Megjegyzés a miserendhez" with a link to the source and its update date. Lines with phone numbers and office contacts are left out.
- Run it again whenever the diocese updates its page; imported churches are recognised by their source key and updated in place.

The parser lives in `scripts/lib/szfvar.mjs`; `scripts/fixtures/szfvar-sample.html` is a real excerpt for testing it.

## Parish editors

A parish editor can edit only the churches linked to them. Create their user under **Authentication → Users**, then in the SQL Editor:

```sql
insert into public.staff (user_id, role, display_name) values ('<their user id>', 'parish', 'Plébánia neve');
insert into public.staff_churches (user_id, church_id) values ('<their user id>', <church id>);
```

The church id is shown under the church's name in the admin panel.

## Google Maps key (optional)

1. In Google Cloud Console, enable **Maps JavaScript API** and create an API key.
2. Restrict it: Websites `https://szbaliint.github.io/*` (and `http://localhost:*/*` for testing), API **Maps JavaScript API** only.
3. Add it as the `GOOGLE_MAPS_KEY` secret and re-run the deploy.

## Running locally

```bash
python3 -m http.server 8000
```

Open http://localhost:8000. To test against your database, temporarily paste the URL and publishable key into `config.js` (don't commit them).

## Data and credits

Church locations: © OpenStreetMap contributors, ODbL. Schedules are entered by editors and the community. A future option is the [miserend.hu](https://miserend.hu) API, after contacting its maintainers as their documentation asks.
