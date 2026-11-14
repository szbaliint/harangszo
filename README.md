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
| `scripts/import-miserend.mjs`, `.github/workflows/import-miserend.yml` | Imports Mass times from miserend.hu. |
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
| `supabase/migrations/006_ranges_weeks_merge.sql` | parish-defined seasons (date ranges), "last Saturday of the month" rules, merging duplicate churches |
| `supabase/migrations/007_rules_tags.sql` | every 2nd/3rd week, Mass tags (language, családos, gitáros…), Advent/Lent/Eastertide/school-year seasons, prayer times (Vesperás, keresztút) |
| `supabase/migrations/008_dated_services.sql` | times for given dates from a parish's own weekly schedule (Ferenciek tere) |
| `supabase/migrations/009_celebrant_place_feasts.sql` | who celebrates, Masses held elsewhere, "ünnepnapokon nincs", one rule for all holy days / public holidays, calendar summer/winter and Christmas time, the "ünnepi" tag |
| `supabase/migrations/010_parish_portal.sql` | parish portal: access requests and approval, editors list, edit history, admin-only fields protected, parish edits locked and stamped |
| `supabase/migrations/011_analytics.sql` | anonymous usage statistics: daily counters, `track()` for the map, `analytics_report()` for the admin's Statisztika page |
| `supabase/migrations/012_retention.sql` | deletes statistics older than 2 years and suggestions decided over a year ago, as the privacy notice promises |
| `supabase/migrations/013_photos.sql` | church photos: Wikimedia Commons photos from the photo import, or the parish's own upload (`church-photos` storage bucket, `set_church_photo()`); `public_data()` returns `photo_url`, `photo_credit` and `photo_page` |

After 003, run the **Import churches from OpenStreetMap** workflow once: it fills in the importance scores of churches already in the database (and adds any new ones).

## How the map stays fast

The map never draws every church. It shows the most important churches in the current view (about 40–180, depending on screen size); zooming in reveals smaller ones, and from street level everything shows. Importance comes from OpenStreetMap at import time (cathedral, basilica, pilgrimage church, Wikipedia entry, city size; chapels rank lower), plus a bonus for churches whose times are entered. Editors can override it per church with "Kiemelés a térképen".

## Duplicate churches

In the admin panel, open either church and click **Összevonás egy másik templommal…**. Pick the other church from the nearby list (or search), choose which place is correct, which name to keep and whose times to keep, then **Összevonás**. Events, suggestions and parish editors move over; the other entry is deleted, and future imports update the kept church. Egyéb → "Lehetséges duplikátum" lists churches with another church within about 130 m.

## Schedules: seasons, feasts, Rorate

- **Seasons:** "Nyári időszámítás" / "Téli időszámítás" follow the clock change; "Nyáron (jún.–aug.)" / "Télen (dec.–febr.)" are calendar months; there are also "Ősszel", "Tavasszal" and "Egyedi időszak". Any of them can be given a "Pontos időszak" (e.g. 05.01–08.31); a parish's own season definitions are read from its note by the diocesan import. The public page shows which season applies and when it changes.
- **Ki tartja:** who says a Mass (or hears confessions): "P. Kamill", "plébános", "püspök". Shown under the time as "Celebrál: …".
- **Más helyszín:** "Helyszín, ha nem a templomban" (temetőkápolna, kórház, idősek otthona) is shown under the time. If the place is another church on the map, choose it in "Másik templomban": the time then also shows on that church ("… tartja"), and counts there on the map instead of at the parish church.
- **Ünnepnapokon nincs:** a regular time that does not happen on holy days of obligation and public holidays (when they fall on a weekday). The miserend.hu import sets it when a weekly Mass is missing on exactly those days.
- **Holy days and public holidays at once:** in "Ünnepi miserend", "Parancsolt ünnepeken" (jan. 1, jan. 6, aug. 15, nov. 1, dec. 25) and "Munkaszüneti napokon" (all public holidays, incl. márc. 15, nagypéntek, máj. 1, okt. 23, dec. 24) apply to every such weekday; a feast added by itself wins over them. Both can also be "Vasárnapi miserend szerint".
- **Weeks of the month:** "A hónap hetei" limits a row to e.g. the 1st, or the last Saturday of the month ("Utolsó"); none selected means every week. The import recognises phrases like "minden hónap utolsó szombatján", "elsőpénteken", "1., 3. és 5. vasárnap", "2. vasárnapja kivételével".
- **Ünnepi miserend:** per church and feast, either "Vasárnapi miserend szerint" or custom times. Custom times replace that day's regular times. Easter-based dates are calculated for every year (`calendar.js`); Ascension and Corpus Christi fall on Sunday in Hungary.
- **Rorate:** a row type that only appears during Advent (first Sunday of Advent to 24 December). The public map shows a "Rorate" filter in Advent.
- **Every n-th week:** "Ismétlődés" (kéthetente, háromhetente…) with the date of one occurrence; the site counts from it and shows the next date.
- **Church-year and school seasons:** "Adventben", "Karácsonyi időben" (dec. 25 – Baptism of the Lord), "Nagyböjtben" (Ash Wednesday – Holy Saturday) and "Húsvéti időben" (Easter – Pentecost) move with the calendar every year; "Tanévben" (09.01–06.15) and "Nyári szünetben" (06.16–08.31) can be given their own dates.
- **What a Mass is like:** language and tags (ünnepi, családos, diákmise, ifjúsági, egyetemista, gitáros, orgonás, kórussal, csendes, előesti, régi rítusú, igeliturgia is lehet, közben gyóntatás, változhat). They show as labels, and the public map can filter by language and kind. The importers read them from miserend.hu's fields and from the parishes' notes ("német nyelvű", "kéthetente", "szentmise v. igeliturgia"…); what they can't place stays as the note.
- **Imaóra, ájtatosság:** Vesperás, rózsafüzér, keresztút and the like, with their name as "Megnevezés".
- Midnight Mass is entered as 00:00 and shown as 24:00 at the end of the day.
- Times are always 24-hour (17:30); the editor accepts 1730, 17.30 or 17,30 too.

## Importing the Székesfehérvár diocese schedule

**Actions → Import Székesfehérvár diocese schedule → Run workflow.** Leave "Only show what would happen" ticked the first time: the run's summary page lists every church on [the diocese's schedule page](https://www.szfvar.katolikus.hu/adattar/miserend) with what would happen to it. Then run it again with the box unticked.

- Each church is matched to the database by its settlement's location and its name (e.g. "Szentháromság" ↔ "Szentháromság-templom"). Churches not found are added at the settlement centre and marked "hely pontosítandó"; find them in the admin panel with Egyéb → "Hely pontosítandó".
- Only regular times (and feast rows the page names, e.g. Pünkösdhétfő) are replaced. Opening hours, events and feast schedules set by hand stay.
- Churches whose times were entered by hand are skipped (tick "Also overwrite hand-entered times" to include them). Churches marked "Kézzel ellenőrzött miserend" are never touched; editing an imported church's times in the admin panel ticks this automatically.
- The page's notes appear on the public site as "Megjegyzés a miserendhez" with a link to the source and its update date. Lines with phone numbers and office contacts are left out.
- Run it again whenever the diocese updates its page. Each run re-checks its earlier matches: if a better match is found, the times move there, and a church the import itself created (and nobody edited) is deleted. Matches an editor confirmed by merging, and locked churches, are kept.
- Two map objects for one church (a point and the building outline, within 60 m and sharing a name word) are merged automatically when one of them is matched.

The parser lives in `scripts/lib/szfvar.mjs`; `scripts/fixtures/szfvar-sample.html` is a real excerpt for testing it.

## Importing Mass times from miserend.hu

**Actions → Import Mass times from miserend.hu → Run workflow.** Leave "Only show what would happen" ticked the first time and read the summary (the full list is in the run's **report** artifact). Then run it again with the box unticked.

- It downloads miserend.hu's daily SQLite export ([API documentation](https://miserend.hu/apidocs)): the v5 file with recurrence rules if it is available, otherwise v4 (single dates for the next six months).
- Concrete Mass dates are turned into the site's rules: weekly times, summer/winter (by the clock change), date ranges, "1st / last Saturday of the month", Rorate in Advent, and feast-day schedules where a feast differs from the usual times. Fortnightly Masses are shown weekly with the note "kéthetente". One-off dates (a parish feast, a special occasion) are left out; the report counts them.
- Each church is matched by its exact location and name (within 400 m, or the same spot); churches not found are added at miserend.hu's coordinates. The public page links to the church's miserend.hu page as the source.
- Churches with hand-entered times or marked "Kézzel ellenőrzött miserend" are skipped (tick "Also overwrite hand-entered times" to include the former). Churches whose times come from the Székesfehérvár diocese import keep them; if such a church only had its settlement's location, it gets miserend.hu's exact one. The diocese import, in turn, replaces times that came from miserend.hu.
- Run it again whenever you want fresher times; v4 only covers six months, so run it at least every few months if v5 isn't available.
- miserend.hu asks everyone using its API to get in touch with its maintainers.

## The Franciscans' weekly schedule (Budapest, Ferenciek tere)

**Actions → Import Ferenciek tere weekly schedule** runs every morning by itself (and can be started by hand). It reads the
weekly "Mise- és gyóntatási rend" PDF from [pestiferencesek.hu/miserend](https://pestiferencesek.hu/miserend/) and stores
its Masses, confession hours, Vesperás, litanies and adoration by date (`dated_services`, migration 008). On those dates the
public page shows these times ("A templom heti miserendje szerint", with a link to the PDF) instead of the regular rules, and
the church page lists the coming days. Who celebrates each Mass is stored as on the parish's own schedule; Mass intentions and the confessors' names are never read. If the PDF's
layout changes, the run fails without writing anything. The parser is `scripts/lib/ferences.mjs`.

## Church photos from Wikimedia Commons

**Actions → Import church photos from Wikimedia Commons → Run workflow** (after migration 013; leave "Only look the photos up" ticked the first time). For churches imported from OpenStreetMap, most important first, `scripts/import-photos.mjs` takes the photo the map object names (`wikimedia_commons` / `image`) or its Wikidata item's image (P18), keeps it only under CC0, public domain, CC BY or CC BY-SA, and stores a 1000 px thumbnail with the credit "Fotó: <szerző> · <licenc> · Wikimedia Commons". A parish's own photo is never replaced; a Commons photo whose file is gone or no longer free is removed. Run it again now and then to pick up new photos. `tests/sql/photos.pglite.mjs` checks the database side (see its header for how to run it).

## Parish editors (plebania.html)

Parishes keep their own times up to date on **plebania.html** (linked from the map's menu as "Plébániáknak"). It shows one church at a time: the week as a board (tap a time to change it, "+ Időpont" to add one, several days at once), feast days, events and the church's details, with a live "Így látják a hívek" preview of the next seven days. Every question is asked in plain words (Milyen gyakran? Az év melyik részében? Ki tartja? Hol?).

How a parish gets access:

1. On plebania.html they create an account (name, e-mail, password), pick their church and say who they are.
2. In the admin panel, **Hozzáférések** lists these requests; **Jóváhagyás** makes them an editor of that church only (they can ask for several churches, e.g. filials). **Hozzáférés megvonása** takes it back.
3. From then on they sign in on plebania.html and see their church straight away. If a parish account opens admin.html, it is sent to plebania.html.

What the database enforces (migration 010): a parish editor can only save its own churches; it can't publish/unpublish, change the map importance or the import keys, even through the API; whatever it saves is locked against imports and shown publicly as "A plébánia adatai szerint · frissítve …". Each church's editor block in the admin panel shows who may edit it, the last saves, and **Megnyitás a plébániai felületen** (admins can open any church there with `plebania.html?templom=<id>`).

Supabase settings for sign-up: **Authentication → URL Configuration**: add `https://<your pages>/plebania.html` to the redirect URLs. **Authentication → Providers → Email**: either set up your own SMTP (the built-in sender only delivers to the project's team members and a few mails an hour), or turn off "Confirm email" so parishes can sign in right after creating the account; access still needs your approval.

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

Church locations: © OpenStreetMap contributors, ODbL. Schedules come from [miserend.hu](https://miserend.hu), the Székesfehérvár diocese, editors and the community; each church's page names its source. Church photos come from Wikimedia Commons (each with its author and licence) or from the parish itself.
