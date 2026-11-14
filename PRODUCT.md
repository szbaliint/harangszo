# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(An installable PWA for the public map; confirmed 2026-11: it should *feel* like a native phone app, not a website.)

## Users

Three groups, weighted equally (owner's answer, 2026-11-14):

- **Someone on the move, right now:** a Catholic travelling, new in town or in a busy day who needs the next Mass or confession near them in seconds, usually one-handed on a phone.
- **Regular churchgoers planning:** locals checking the week ahead at their own and nearby parishes (Sunday Mass, confession, feast days, Advent Rorate, events).
- **Older believers:** a large share of users are elderly; reading must be effortless and the path short.

Two operator audiences use separate surfaces:

- **Parish staff** (often a volunteer or parish office worker, sometimes not technical) keep their own church's schedule up to date on `plebania.html`, on a phone or an office computer.
- **The owner/admin** (Bálint) curates all ~4,800 churches, reviews suggestions and access requests, merges duplicates and reads usage statistics on `admin.html`, mostly on a laptop.

## Product Purpose

Harangszó ("the sound of the bell") answers one question for Hungary: *where and when is there Mass, confession or adoration near me?* It shows every Catholic church (Roman and Greek Catholic) on a map with its next times, a 7-day view and its weekly order, including feasts, seasons and parish-specific dated schedules.

Success: a believer finds a correct, upcoming time near them in a few seconds; parishes keep their own data current without help; the owner can see where data is missing and fix it.

## Positioning

- Map-first and "next time first": the answer to *what's next, nearby* comes before any browsing.
- Schedules are understood liturgically, not as flat lists: movable feasts, holy days of obligation, public holidays, Advent/Lent/Eastertide/school-year seasons, nth-week and fortnightly rules, Rorate only in Advent, feast days that follow the Sunday order, and dated weekly schedules that override the rules.
- Parishes edit their own church directly, in plain words, and their saves lock the data against imports.
- Free, non-commercial, volunteer-run, privacy-respecting (no cookies, anonymous counters only).

## Operating Context

- Phone in hand outside or on the way, often in sunlight or in a dark church; laptop for parish offices and the admin.
- Hungarian only; Hungarian dates and 24-hour times; Hungarian church vocabulary (szentmise, gyóntatás, szentségimádás, rorate, búcsú, előesti mise, ünnepi miserend).
- Data comes from parish uploads, believers' suggestions, miserend.hu, diocesan sites, the Franciscans' weekly PDF and OpenStreetMap locations. Many churches (~1/3) still have no times.

## Capabilities and Constraints

- **Public map** (`index.html`, `app.js`): full-screen map (Google Maps live, Leaflet/CARTO fallback) with clustered markers, search, filters (day, place, Mass, confession, open now, events this week, Mass type/language, Rorate), nearest upcoming times, list, saved churches (localStorage), church detail (next time, actions: directions / call / website / suggest a correction, 7-day strip, weekly order, dated weeks, feasts and Advent, events, notes, share). Installable PWA, works offline with the last list, anonymous statistics with an opt-out.
- **Parish portal** (`plebania.html`): sign up → request access → admin approves → week board and question-style time editor (shared `schedule-editor.js`), feasts, events, details, opening hours, live 7-day preview, save bar.
- **Admin** (`admin.html`): church list with filters and status tags, full church editor (same schedule editor + advanced raw rule fields), suggestions, access requests, editors, edit history, merge, Statisztika.
- **Legal** (`jogi.html`): impresszum, privacy notice, terms (operator name/contact still to be confirmed).
- Static site, no build step, vanilla JS/CSS on GitHub Pages; Supabase backend (RLS, RPCs). No new runtime dependencies without a reason. Tests: `npm test` (Playwright, mocked Supabase).
- Must work offline-first on the map, with a ~5,000-church dataset rendered client-side.

## Brand Commitments

- Name: **Harangszó**. Nothing visual is fixed (owner, 2026-11-14): colours, type, icon, layout and the kind-colour mapping may all change.
- Voice: plain, warm, respectful Hungarian; never salesy; no exclamation-heavy copy.
- The site is not an official Church, diocese or parish site and must not imply it.

## Evidence on Hand

- Real data: ~4,800 churches, ~7,900 schedule rules, live in Supabase.
- No testimonials, user counts, endorsements or press exist; do not fabricate any.
- Owner's verdict on the current (Nov 2026) design: looks generic, too busy/complex, not native enough, not churchy enough.

## Product Principles

1. **The next time first.** Every surface leads with the answer, then offers depth on demand.
2. **Calm over clever.** Fewer controls, fewer panels; anything that isn't helping someone get to a church recedes.
3. **Rooted, not themed.** It should feel like it belongs to the Catholic tradition through restraint and care, never through clip-art piety.
4. **Native-feeling on a phone.** Gestures, sheets, type and touch targets behave like a real app.
5. **Trust through honesty.** Say where data comes from and when it may be missing; urge people to check with the parish for important occasions.

## Accessibility & Inclusion

- Older users: large, high-contrast text; generous tap targets; minimal steps; no information carried by colour alone.
- WCAG 2.2 AA as the floor; respect reduced motion, dark mode and larger system text.
