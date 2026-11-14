---
version: 1
slug: "index-html"
primary_target: "index.html"
related_targets: ["app.js","styles.css"]
---

# Surface brief: public map app (index.html)

Mode: Operate (phone-first, installable). Audience, job and constraints: see PRODUCT.md.
Chosen 2026-11-14 after five rounds; the owner rejected themed, atmospheric and generic-app directions as "AI slop" and chose the real-material, church-first direction.

## Direction contract

THESIS: The app opens on a real church, not on a map or a list. The nearest church with an upcoming Mass fills the top of the screen as an actual photograph; under it, plain typeset facts answer "when, where, how far". It refuses the category default (full-screen pin map plus bottom sheet) and every invented ornament: no gradients, glow, textures or themed objects.

OWN-WORLD: White ground, near-black ink (#111), two greys (#555, #8a8a8a), hairline rules (#e6e6e6), one accent red (#b4232a) that only ever means "the next one / what applies now". Real photographs (Wikimedia Commons, credited on the image) and real OpenStreetMap streets are the only imagery. Type is the platform's own (SF on iOS, Roboto elsewhere), light weight for the big time, bold for church names, tabular figures everywhere; sizes from one scale (13/15/17/22/64). Controls are plain native ones: a black primary button, outlined secondary buttons, a hairline tab bar with line icons.

STORY: The visitor sees which church, its next time and how far it is before reading anything, trusts it because the picture and the facts are real (with the source and "vasárnapra érvényes"-type notes shown), and goes: Útvonal, or the next church below.

FIRST VIEWPORT: Top 42%: the church's photograph edge to edge, with "Keresés" and ♡ as small white pills over it and the photo credit in its corner. Below on white: the day line (date · liturgical week), the time at 64px light with the kind in red and its validity note beside it, the church name 22px bold, address · distance · walking minutes, a row of three buttons (Útvonal primary, Heti rend, Honlap), then "Utána a közelben" as hairline rows (time | church, street | distance). Bottom tab bar: Most · Térkép · Mentett. A church without a photo opens with the same layout minus the photo, never a placeholder image.

FORM: Grounded direction "The church first" from the fifth hand (drawn from real material only, outside the dealt list after four rerolls). seed:46f4e01d45dbb702

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Related surfaces

The same world extends to the map tab (real tiles, toned grey, black time pins, red for the next), the list, the church page (photo header, then the 7-day strip and the week), the parish portal, the admin and jogi.html: white, ink, hairlines, one red, the platform font.

## Open decisions

- Photo coverage: which churches get a photo and how (Wikidata/Commons via OpenStreetMap tags), stored with author and licence.
