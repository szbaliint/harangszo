# Harangszó

Katolikus templomok térképe Magyarországon: misék, gyóntatás, nyitvatartás, események.

A map of Catholic churches in Hungary with Mass and confession times, opening hours and events.

> **Prototype.** The churches are real, but every schedule in `data.js` is invented sample data.

## Running it

It is a static site: open `index.html` through any local web server, for example

```bash
python3 -m http.server 8000
```

and visit http://localhost:8000.

## Map

- **Without a key** the map uses OpenStreetMap tiles (via Leaflet).
- **With a key** it switches to Google Maps automatically.

### Adding the Google Maps key

1. In Google Cloud Console, enable **Maps JavaScript API** and create an API key.
2. Restrict the key:
   - Application restrictions → **Websites**: `https://szbaliint.github.io/*` (and `http://localhost:*/*` for local testing)
   - API restrictions → **Maps JavaScript API** only
3. In this repository: **Settings → Secrets and variables → Actions → New repository secret**, name `GOOGLE_MAPS_KEY`.
4. Re-run the **Deploy to GitHub Pages** workflow (Actions tab), or push any commit.

The key is inserted into `config.js` only at deploy time, so it never appears in the repository. It is visible in the published page, which is normal for Maps JavaScript; the website restriction is what protects it.

## Corrections

"Javítás beküldése" opens a pre-filled GitHub issue labelled `javaslat`. This is a stopgap until the app has its own backend.

## Data

`data.js` holds the sample churches. The plan is to load real data from the [miserend.hu](https://miserend.hu) API (v4), after contacting its maintainers as their API documentation asks.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page shell |
| `styles.css` | Styles (light and dark) |
| `data.js` | Churches and sample schedules |
| `app.js` | Filtering, list, detail view, map |
| `config.js` | Key placeholder and repository name |
| `.github/workflows/pages.yml` | Deploys to GitHub Pages and inserts the key |
