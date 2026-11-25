---
version: 1
slug: "index-html"
primary_target: "index.html"
related_targets: ["app.js","styles.css"]
---

# Surface brief: public map app (index.html)

Mode: Operate (phone-first, installable). Audience, job and constraints: see PRODUCT.md.
Replaced 2026-11-25 ("a fully new design, started from zero": layout and flow may change; the old church-first look
was too cold, not beautiful enough, not app-like, hard to use; benchmark Airbnb / Citymapper). Chosen from a dealt hand:
the departure-board world won over the roll (Mária Terézia-sárga), the liturgical-colour pick and a photo-shelf wall.

## Direction contract

THESIS: Nearby Masses and confessions are departures. Home is a live board ranked by start time with the walk built in,
so the answer to "where should I go now" is the top row, not a search. It refuses both the map-plus-sheet default and
the previous church-first white page.

OWN-WORLD: Navy board (#13233f, panel #1d3257) over white rows; one alert amber (#ffb703) that only marks "leave now"
and anything that changed, held until seen; red (#e5483a) only for "most tart" (going on now); greys for status at rest.
Overpass (self-hosted, highway-signage grotesk) for everything, tabular figures, 800 for times and headings, small
uppercase column labels. The pass: the chosen Mass as a segmented card with labelled fields (IDŐ, TEMPLOM, SÉTA,
ÁLLAPOT) and the church's real photo; rounded 18px cards, 12px segmented controls, pill status chips. Standard native
controls: segmented control, tab bar, search field, buttons.

STORY: The visitor opens the app and sees, ranked, what starts next near them and whether to leave now; taps a row for
the church's pass (photo, next times, week, Útvonal); planners switch day or search; nothing needs a map first.

FIRST VIEWPORT: Navy header: day · time · place line, "Indulások" 28px, segmented Mind / Mise / Gyónás. Below, the amber
pass for the Mass to leave for now (time 34px, church, kind · distance · walk, Útvonal). Then the board: column labels
IDŐ / TEMPLOM / SÉTA / ÁLLAPOT and rows (time 18px 800 | church + kind | walk minutes | status chip: "most tart" red,
"indulj 17:54" amber, "42 perc" grey). Tab bar: Indulások · Térkép · Keresés · Mentett. Signature move: rows rerank in
place as time passes (FLIP, critically damped), a changed row flashes amber and holds it.

FORM: Challenger "boarding pass and gate board" (vernacular ephemera), chosen over the roll's assigned direction (my
list #3) and my pick. seed:1069256aac57cc89
Raises kept for church identity: the real church photo on every pass; the liturgical day line (date · Évközi 34. hét)
and next Sunday's feast in the header; each time paired with its proof (source, validity note).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Related surfaces

The same world reaches the map (grey tiles, navy time pins, amber for "leave now"), search, the church page (the pass,
then the 7-day strip and the week as a timetable), the parish portal and the admin (navy rail/header, white work area,
unsaved changes held in amber until saved), and jogi.html.

## Motion

Apple fluid rules: press feedback on pointer-down; sheets and the church page enter and leave along the same path with
critically damped springs; board rows rerank by FLIP from their current position; reduced motion = cross-fades only.
