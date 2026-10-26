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
