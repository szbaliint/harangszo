# Harangszó redesign: one modern app look

Date: 2026-11-09 · Status: design approved in chat, awaiting spec review

## Goal

Make the map (`index.html`), the parish portal (`plebania.html`) and the admin page (`admin.html`) look and feel like
one modern app: calm and sacred, phone-first, installable.

Problems it fixes (from the owner):

1. The pages look dated and do not match each other.
2. The church detail is cluttered on a phone.
3. The parish editor is hard to use, especially on a phone.
4. It does not feel like an app.

Done when:

- all three pages are built from one shared set of parts (tokens + components in `styles.css`);
- on a phone the church detail shows the next Mass, today's times and the week before anything else;
- a parish can set up a weekly schedule on a phone without help;
- the public map installs to the home screen and opens without the browser bar.

## Constraints (unchanged)

- Static site, vanilla JS + CSS, no build step; GitHub Pages; Supabase backend.
- No change to the data model, RPCs, saving, imports or permissions. This is presentation and navigation only.
  The one small new feature is **Mentett** (saved churches, stored in `localStorage` only).
- UI text stays Hungarian; light and dark mode both stay; `prefers-reduced-motion` is respected.
- Every new file must be added to the `cp` line in `.github/workflows/pages.yml`.
- Test with Playwright against `python3 -m http.server`, Supabase mocked (as in `CLAUDE.md`).

## Approach

Design system first, then one page at a time; each step ships on its own so the live site is never half-broken:

1. Design system: rewrite `styles.css` (tokens, type, components). Pages keep working on the old class names until
   they are rebuilt (the old rules are kept, then deleted per page as it moves over).
2. Map, list and church detail (`index.html`, `app.js`).
3. Parish portal (`plebania.html`, `plebania.js`), including the shared schedule editor.
4. Admin (`admin.html`, `admin.js`), reusing the shared schedule editor.
5. App install (manifest, icons, service worker) and transitions.

Mockups approved for each section are in `2026-11-09-redesign-mockups/` (open in a browser). They are references,
not code to copy. `1-tone.html` was drawn before the font choice and still shows IBM Plex/Spectral; the fonts in
`1-fonts.html` (pair B) and the later mockups win.

## 1. Design system

### Tone A, "warm parchment"

| token | light | dark |
| --- | --- | --- |
| `--bg` | `#f6f3ec` | `#14120f` |
| `--surface` | `#fffdf8` | `#1e1b17` |
| `--sunken` | `#efe9dc` | `#26221d` |
| `--line` | `#e6dfd0` | `#332e27` |
| `--border` | `#cfc5b1` | `#4a4339` |
| `--ink` / `--ink-2` / `--ink-3` | `#1d1a16` / `#5b5447` / `#857c6c` | `#efe9de` / `#bdb3a2` / `#948a79` |
| `--accent` (Mass) / soft | `#233f8c` / `#e6e9f4` | `#9db1ee` / `#232a40` |
| `--penance` (confession) / soft | `#6a2e8c` / `#f0e6f4` | `#cfa3e6` / `#2f2238` |
| `--gold` (adoration, feasts, Sunday) / soft | `#9a6b10` / `#f5ead2` | `#e2b85e` / `#352a17` |
| `--open` / soft, `--closed` | `#1d7a4c` / `#e0f0e6`, `#a2361f` | `#6fd3a0` / `#173126`, `#f08a70` |

Existing token names are kept where they exist (`--accent`, `--penance`, `--gold`, `--open`, `--closed`, `--ink-2`…)
so the map marker code (`pal()` in `app.js`) keeps working. Contrast: body text and tag text must reach WCAG AA
(4.5:1) on their backgrounds in both modes; check with a script before shipping.

### Type

- Headings and church names: **EB Garamond** (600/700).
- Everything else: **Source Sans 3** (400/600/700).
- Times: Source Sans 3 with `font-variant-numeric: tabular-nums`. **No monospace, no IBM Plex, no Spectral** anywhere.
- Loaded from Google Fonts with `display=swap`; both cover Hungarian (ő, ű).
- Scale: page title 28–30px, section title 19–23px, body 15–16px, small 12.5–13.5px.

### Shape and motion

- Radius: 12px fields, 16–18px cards, 22–26px sheets and hero cards, pills fully round.
- Shadows: soft and warm (`rgb(40 30 10 / .16)`), only on floating things (glass bars, sheets, toasts).
- Glass: `--glass` with `backdrop-filter: blur(14px)` for floating bars over the map.
- Easing `cubic-bezier(.2,.8,.2,1)`, 180–280ms; none under `prefers-reduced-motion`.
- Tap targets at least 44px.

### Components (shared by all pages)

Buttons (primary, secondary, quiet, danger; pill), filter chips with a colour dot, tags (mass, confession, adoration,
open, neutral, warning), segmented control, toggle, fields (label, hint, error, focus ring), day picker (7 pills),
list card, grouped list (rows inside one card), fold-out row (accordion), floating tab bar, bottom sheet / side
dialog (bottom sheet on phones, centred panel ≥ 640px), save bar, toast, empty state.

Each component is one block of CSS in `styles.css` under a clear heading; page files hold only layout.

## 2. Map, list and church detail (phone first)

Structure as today (full-screen map, bottom sheet, floating tab bar, desktop side panel), redrawn:

- **Map:** glass search bar always on top; filters as chips under it (Ma, Mise, Gyóntatás, Most nyitva, ⋯ for the
  rest: day, place, Mass type, Esemény a héten, Rorate in Advent). The "Legközelebb" card shows the next two times
  near you (time tile, name, kind, distance). Markers keep the current clustering and time pills, recoloured.
- **Tabs:** Térkép · Lista · **Mentett**. Search moves onto the map, so the Keresés tab goes.
- **Mentett:** ♡ on a church saves its id in `localStorage` (try/catch, works without it); the tab lists saved
  churches with their next time. No account, nothing on the server.
- **List:** same content as today; at most two tags per card; distance in small grey figures.
- **Church detail**, top to bottom: open/closed + rite tags; name; address · distance; hero card "Következő mise"
  with time and "… múlva"; four actions (Útvonal, Hívás, Weboldal, Javítás); 7-day strip; that day's times in one
  grouped list (past times faded). Then fold-out rows: Heti rend, A templom heti miserendje (dated weeks, with
  source link), Ünnepek és advent (feast schedule, Rorate), Események, Megjegyzés. Folded rows show a count.
  "Javítás" opens the suggestion form in a sheet. Approximate-location warning stays, as a small note under the
  address. Every piece of information shown today is kept.
- **Desktop:** the side panel holds list and detail as today; the top search + chips sit in the panel header.

## 3. Parish portal

Same flow as today: sign in → request access → admin approves → edit. Phone first:

- **Sections** move into the floating tab bar: Heti rend · Ünnepek · Események · Adatok.
- **Week board:** one card per day, Sunday first and in gold; each time a coloured tile (time + kind + short note);
  tap to edit, ＋ to add.
- **Time editor** (sheet on phone, dialog on laptop): four questions answered by taps: Mi lesz? (kind),
  Hánykor? (start, optional end), Mely napokon? (day picker), Milyen gyakran? (every week, every two weeks,
  nth week of the month). Under them a live one-sentence summary in Hungarian. "Időszak, nyelv, ki mutatja be,
  máshol tartják ›" opens the rest (period, valid range, tags, celebrant, place). Same fields as today's editor.
- **Save bar:** appears only with unsaved changes ("N nem mentett változás · Előnézet · Mentés"); toast after save
  ("Elmentve · már látszik a térképen"); leaving with unsaved changes asks first (as today).
- **Preview:** on phones a segmented switch at the top (Szerkesztés / Így látják a hívek); on laptops the preview
  column stays beside the editor.
- Sign-in, picker and access-request screens get the new parts (fields, buttons, cards); no flow change.

The week board and time editor become one shared module, `schedule-editor.js` (new file, plain script exposing
`window.ScheduleEditor`), used by both the portal and admin. It takes the church's services and returns them;
saving stays in each page (`save_church` for both, as now).

## 4. Admin

Laptop first, three columns; on phones they stack (sections → list → church):

- **Left rail:** Templomok (count), Javaslatok (badge), Hozzáférések (badge), Összevonás; signed-in user, sign out.
- **List:** search (name, place, id) and filter chips (the current filters, as chips); status tags per church
  (plébánia kezeli, N javaslat, nincs időpont, hely bizonytalan, import source).
- **Church:** header with name, address, id, last saved by; Közzétéve toggle; Megnyitás a térképen; Mentés.
  Tabs: Miserend · Ünnepek · Események · Adatok · Szerkesztők · Előzmények. Beside the schedule: open suggestions for
  this church (Átveszem / Elutasítom), admin-only fields (importance, import keys, lock state), editors.
- **Schedule:** the shared week board + time editor from the portal, plus a **Haladó** section only admin sees for
  the raw rule fields (valid ranges, weeks[], every + anchor, feast_skip, feast). The old row-of-fields editor
  (`serviceRow` etc.) is removed. Optional later: a read-only "all fields" table view if the board hides too much.
- Javaslatok, Hozzáférések and Összevonás keep their logic, restyled with the shared parts.
- Admin-only fields stay protected by the `churches_guard` trigger; nothing here changes permissions.

## 5. App install and motion

- `manifest.webmanifest`: name/short name "Harangszó", `display: standalone`, `start_url: ./`, `scope: ./`,
  background `#f6f3ec`, theme `#233f8c`, icons 192/512 + maskable + Apple touch icon 180.
- Icon: an original simple bell, gold on deep blue (SVG source in `icons/`, PNGs exported).
- `sw.js` (service worker), registered from `index.html` only:
  - precaches the public app shell: `index.html`, `styles.css`, `app.js`, `calendar.js`, `data.js`, `config.js`,
    fonts CSS + font files (stale-while-revalidate for fonts);
  - never caches Supabase calls, Google Maps, map tiles, `plebania.*` or `admin.*`;
  - church data keeps the current `localStorage` cache (`readCache`/`writeCache`) as the offline copy;
  - offline map: a calm note "Nincs internet · a lista működik" and the list stays usable.
- Versioning: `sw.js` has a `__BUILD__` placeholder; `pages.yml` fills it with `${GITHUB_SHA}`. A new version shows a
  toast "Új verzió érhető el · Frissítés".
- Install: a quiet "Telepítés a kezdőképernyőre" item in the menu. Android: the `beforeinstallprompt` event;
  iPhone: a short how-to sheet (Megosztás → Főképernyőhöz adás). No automatic pop-ups.
- Motion: church detail slides in; the sheet follows the finger (existing drag); tab switches fade; View Transitions
  API where supported, instant elsewhere; nothing under reduced motion.
- `pages.yml` `cp` line gains: `schedule-editor.js sw.js manifest.webmanifest icons/` (with `-r` for the folder).

## Error handling

- `localStorage` (Mentett, cache): every read/write in try/catch; the app works with it empty or blocked.
- Service worker: registration failure is ignored (the site works as a normal page); an old cache never serves
  admin or portal pages.
- Fonts: system fallbacks set (`Georgia`/serif, `system-ui`/sans-serif) so a failed font load still reads well.
- Portal/admin save errors: shown inline in the save bar with the server message, changes kept.

## Testing

- Playwright against `python3 -m http.server`, Supabase mocked, at phone (iPhone 13) and laptop (1440×900) sizes,
  light and dark: map, list, detail (folds open), Mentett add/remove, portal add/edit/delete a time + save + preview,
  admin open church, edit via Haladó, accept a suggestion.
- Screenshot comparison against the mockups by eye for each step.
- Contrast check script over the token pairs (AA).
- Service worker: offline reload of the map shows the list from cache; `admin.html` offline does not come from cache.
- The existing scheduling logic (`calendar.js`, `dayInfo`, `dayList`) is untouched; any test that exercises it must
  still pass.

## Out of scope

Push notifications, accounts for the public, server-side favourites, new data fields, native apps, changing the
map provider.
