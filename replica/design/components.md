# Harangszó map-first layout — component specs

Pattern taken from the recon (full-screen map, floating glass controls, nearest strip with a central action,
floating tab bar, bottom sheet). Everything below is Harangszó's own: its palette (Marian blue, violet for
confession, gold), its fonts (Spectral, IBM Plex Sans/Mono), its copy, and inline SVG icons drawn for this
project (simple strokes, Lucide-style geometry; no icons from the reference app). Vanilla CSS, no Tailwind:
components read the custom properties in `styles.css` (mirrored in `tokens.css`).

Screens: S01 = map with floating UI, S02 = bottom sheet (list / church detail / search).

```
Map canvas
  what      full-bleed Leaflet map behind everything (position fixed, inset 0)
  tiles     CARTO "light_all" in light theme, "dark_all" in dark theme (© OpenStreetMap contributors © CARTO);
            Google Maps when a key is set (unchanged)
  a11y      role=application with a label; every marker also reachable through the list
  used on   S01
```

```
Time marker
  variants  mass (accent fill, on-accent text), conf (penance fill, on-penance text),
            none (marker-none-bg fill, ink-2 text, 1.5px border-input ring), dot (zoomed out: 12px circle, no label)
  content   the next time today (or on the chosen day): "18:00"; "–" when none; church glyph when no time is known
  size      pill 22px high, min-width 38px, mono 11px/600; dot 12px
  states    default, selected (2px gold ring + scale 1.15 + z-index top), hover (title tooltip = church name)
  tokens    radius pill, shadow float
  a11y      Leaflet marker with title; keyboard: list cards are the accessible path
  used on   S01
```

```
Cluster marker
  what      churches close together on screen (same 72px grid cell) below zoom 14 merge into one circle with their count
  variants  colour follows the group: a Mass still to come → accent, only confession → penance, otherwise neutral
  size      30 / 36 / 42 / 50px by count (<10, <100, <1000, more), mono 12px/700, 4px soft halo in the same colour
  states    default, hover (scale 1.08); tap = zoom in on the group's bounds
  a11y      title "N templom – nagyíts rá"; the list remains the accessible path
  used on   S01
```

```
User location dot
  variants  one
  tokens    accent fill, 4px glass halo, pulsing ring (disabled with prefers-reduced-motion)
  used on   S01 after "Saját helyzetem"
```

```
Brand chip (top left)
  content   "Harangszó" (Spectral 700) + menu button opening: Szerkesztőknek, a note about data
  tokens    glass bg, radius pill, shadow float
  used on   S01
```

```
Glass control stack (right side, above the strip)
  variants  vertical stack of round icon buttons: Szűrők (opens the filter sheet), Saját helyzetem (locate), zoom +/-
  size      44px buttons (touch target)
  states    default, hover, active (accent icon + accent-soft bg when a filter is on, with a count badge), focus-visible ring
  a11y      <button> with aria-label; aria-pressed for toggles
  used on   S01
```

```
Nearest strip
  layout    [card] [primary round button] [card], floats above the tab bar; on desktop sits at the bottom of the map area
  card      glass pill 56px: status circle (time marker colours, mono time) + 2-line name (sm/600, ellipsis) +
            "1,2 km · Nyitva"-style meta (xs, text-faint); tap = open the church in the sheet
  primary   64px circle, accent fill, bell glyph, label "Legközelebbi mise" for screen readers and as a tooltip;
            tap = the nearest church with a Mass still to come today (within 25 km), opened in the sheet
  states    loading (skeleton shimmer), empty ("Nincs több mise ma a közelben" card), no location (uses the chosen town)
  used on   S01
```

```
Tab bar (floating)
  tabs      Térkép, Lista, Keresés — icon + 11px label; active = accent-soft inner pill + accent icon
  size      60px high, max-width 360px, centred, 12px above the safe area
  a11y      <nav> with role=tablist semantics kept simple: buttons with aria-pressed
  used on   S01/S02 (phone); desktop shows the same bar at the bottom of the map
```

```
Bottom sheet
  states    closed (only the map), peek (header + first rows, 42% of the height), full (calc(100% - 64px))
  parts     grabber (36×5, border colour), header (title + close/back), scroll body
  behaviour drag the grabber or header to move between states; tap grabber toggles peek/full; Esc closes;
            Lista/Keresés tabs open it at full; a marker or card opens it at peek with the church
  desktop   (≥900px) a floating left panel 400px wide, full height minus 24px, always open, no grabber
  tokens    surface bg, radius sheet (top corners), shadow sheet, motion sheet
  a11y      role=dialog aria-modal=false with a label; focus moves to its heading when opened by keyboard
  used on   S02
```

```
Sheet header for a church
  parts     status pills (Nyitva / rite), name (Spectral xl), address · distance, big next time
            (hero-time mono, with "KÖVETKEZŐ MISE" micro label above), then actions: Útvonal (primary pill), Javítás
  used on   S02
```

```
Filter sheet content
  parts     day select, Mise / Gyóntatás / Rorate / Most nyitva / Esemény a héten as icon tiles (2 columns),
            Mass kind (language, family…) select
  tile      64px, icon + label, active = accent outline + accent-soft
  used on   S02
```

```
Primary pill button
  tokens    accent bg, on-accent text, radius pill, 44px, font sm/600
  states    default, hover (darken 8%), focus-visible, disabled (50% opacity)
  used on   S02 (Útvonal), suggestion form
```
