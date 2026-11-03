# Recon map: Budicheck (iOS/Android app, seen through its public website)

Scope: **the map screen layout only** — full-screen dark map, score-style markers, floating controls,
"nearest places" strip with a central action button, floating tab bar, and the bottom-sheet detail.
For: Harangszó (this project) — the church map gets this layout; content, data and features stay Harangszó's.
Date: 2026-11-03

Clean-room rules followed: only the public marketing site was read, at human speed, in the user's browser.
No login, no app binary, no JS bundles, no private APIs. Screenshots in `screens/` are reference only and are
git-ignored; nothing from them (logo, mascot, icons, illustrations, copy, the "B" mark, the lime brand) ships.

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | marketing site | https://budicheck.app/ | hero, "Három lépés" section with three app screenshots, LIVE, SOS, city map |
| 2 | app screenshot "map" | shown on the site, section "Nézd meg, mi van körülötted" | the map screen, read at full size |
| 3 | app screenshot "rate" | same section | bottom sheet over the map |
| 4 | app store listings | linked from the site (App Store id6775079966, Google Play hu.budicheck.app) | not needed for the layout slice |

## Core loop (of the slice)

Open the app → the map shows what is near you, colour-coded by quality → the two nearest places sit at the
bottom → tap one (or a marker) → a bottom sheet shows its details.

## Screens

| ID | screen | route / how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Map (home) | app start; middle tab | see places around you | full-bleed dark map, score markers, user dot, SOS button (bottom left), glass control pill (filter, locate) bottom right, nearest-places strip (2 cards + central round action button), floating tab bar | filled (Budapest) |
| S02 | Place sheet | tap a marker / nearest card | details and action for one place | bottom sheet with grabber, back chevron, title + type, big score ring, gradient slider, segmented toggles, rows with chevrons, full-width primary pill button | open over the map |
| S03 | Country overview map (website only) | site section "42 186 hely" | density of places | dark country silhouette with lime outline, grey dots, city labels in mono caps, hover per city | static |
| S04 | LIVE / filter chips (website mock) | site section "Milyen most?" | status reports and type filters | dark card, status rows with time-ago, 4 square icon chips (one active, lime outline) | one chip active |

## Flows

```
F01 Find the nearest good place
    S01 (map opens on your location) -> tap nearest card -> S02 sheet
    happy path clicks: 1
    edge: no location permission, nothing within range ("0 hely 12 km-en belül"), place closed
F02 Browse the map
    S01 pan/zoom -> tap marker -> S02 -> back chevron / swipe down -> S01
    happy path clicks: 1
F03 Emergency: nearest open
    S01 SOS button -> nearest open place with distance and "Indulás" (start directions)
    happy path clicks: 2
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Score marker | filled circle with number, colour by score (lime → yellow → orange → red); outlined circle with a count (unrated/group); icon marker (category) | default, selected | S01 |
| User location dot | lime dot with halo | — | S01 |
| Round FAB | danger (SOS, red), primary (large lime, centre of the strip) | default, pressed | S01 |
| Glass control pill | 2 icon buttons (filter, locate) on blurred dark glass | default, active | S01 |
| Nearest-place card | pill card: score circle + 2-line name + distance with open dot | default, pressed | S01 |
| Floating tab bar | 4 icon tabs on a dark rounded bar; active tab = lighter inner pill | active, inactive | S01 |
| Bottom sheet | grabber, header with back, scrollable body | peek, open | S02 |
| Score ring | large number /10 with glow ring and a caps mono label | by score | S02 |
| Segmented toggle | 2 options, active filled lime | — | S02 |
| List row | icon + label + value + chevron, inside a rounded group | default, highlighted | S02 |
| Primary pill button | full width lime, icon + label | default, disabled | S02, site header |
| Icon chip (filter) | square tile with icon + label | default, active (lime outline + tint) | S04 |

Visual language: near-black background (#000 / #111 surfaces), off-white text (#f4f7ec), one loud accent
(lime #c6ff3b, dark text on it), score scale lime → yellow → orange → red, rounded everything (pills, 20–28 px
cards), glassy translucent floating controls, display font Space Grotesk 700, body Hanken Grotesk, mono caps
micro-labels with wide letter spacing.

## Inferred data model (slice only)

```
Place   id, name, type (Étterem, Kávézó…), lat, lon, score (0–10, one decimal), open_now, distance (computed)
        evidence: S01 cards "Trónterem Bisztró 9.5 · 30 m", S02 header
        confidence: high
Report  place_id, status (Tiszta, Koszos, Nincs papír…), created_at
        evidence: S04 "2 jelzés · 9 perce"
        confidence: medium
```

## Mapping to Harangszó

| Budicheck | Harangszó |
| --- | --- |
| score marker colour | what happens at the church today: Mass soon / confession / nothing; number = next Mass time ("18:00") |
| two nearest places + central action | two nearest churches with their next Mass; central button = "Legközelebbi mise" (next Mass nearby, like SOS) |
| SOS red button | not needed; the central button covers it |
| filter + locate pill | filters (Mise, Gyóntatás, nyelv/jelleg, nap) + "Saját helyzetem" |
| tab bar (toplista, térkép, profil, keresés) | Térkép, Lista, Keresés, (Szerkesztőknek link stays in a menu) |
| place sheet | church detail (today, week table, notes, feasts) as a bottom sheet on phones, side panel on desktop |
| lime brand | Harangszó's own palette (keep its blue accent / penance purple / gold); only the layout pattern is taken |

## Feature matrix

See `features.csv`. Must: 8, should: 6, could: 3, skip: 5.

## Out of scope (cannot or should not be cloned)

- Budicheck's name, logo, "B" mark, mascot and lime brand identity, its icons and illustrations, its copy.
- Ratings, XP, leaderboards, cards, badges: not part of Harangszó's purpose.
- Its place database (42 186 places) and live reports: their data.
- Apple Watch app and native mobile apps: Harangszó stays a web app.

## Size

Screens 2 (map + sheet) inside the existing app, flows 3, no new entities. Hard parts: a bottom sheet that
drags well on phones and turns into a side panel on desktop; marker clustering/culling with labelled markers
while staying fast with ~6000 churches; dark map tiles that stay legible (attribution kept). Size: S–M.
